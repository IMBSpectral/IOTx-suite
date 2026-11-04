import crypto from "node:crypto";
import { CloudError, openDatabase, sessionFor, updateCloud, type CloudConfig } from "./cloud";
import { deliver } from "./cloud-ops";

/**
 * How the app's users sign in (Cloud tab → Settings): email + password, a
 * one-time code by email, whether new people can sign up, and which email
 * domains may sign in at all.
 */

export type AuthSettings = NonNullable<CloudConfig["auth"]>;
export const DEFAULT_AUTH: AuthSettings = { password: true, emailCode: false, forge: true, google: false, signups: true, allowedDomains: [] };

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const authSettings = (cfg: CloudConfig): AuthSettings => ({ ...DEFAULT_AUTH, ...(cfg.auth ?? {}) });

export async function setAuthSettings(projectId: string, patch: Partial<AuthSettings>) {
  const cfg = await updateCloud(projectId, (c) => {
    const next = { ...authSettings(c) };
    if (typeof patch.password === "boolean") next.password = patch.password;
    if (typeof patch.emailCode === "boolean") next.emailCode = patch.emailCode;
    if (typeof patch.forge === "boolean") next.forge = patch.forge;
    if (typeof patch.google === "boolean") next.google = patch.google;
    if (typeof patch.signups === "boolean") next.signups = patch.signups;
    if (Array.isArray(patch.allowedDomains)) {
      const list = [...new Set(patch.allowedDomains.map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
      const bad = list.find((d) => !DOMAIN.test(d));
      if (bad) throw new CloudError(`${bad} isn't a domain like example.com.`);
      next.allowedDomains = list.slice(0, 20);
    }
    if (!next.password && !next.emailCode && !next.forge && !next.google) throw new CloudError("Keep at least one way to sign in turned on.");
    c.auth = next;
  });
  return authSettings(cfg);
}

function domainAllowed(s: AuthSettings, email: string) {
  if (!s.allowedDomains.length) return true;
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return s.allowedDomains.includes(domain);
}

/** Checks before email + password sign-up or sign-in. */
export function checkPasswordAuth(cfg: CloudConfig, email: string, kind: "signup" | "login") {
  const s = authSettings(cfg);
  if (!s.password) throw new CloudError("This app signs people in with an emailed code, not a password.", 403);
  if (kind === "signup" && !s.signups) throw new CloudError("This app isn't taking new sign-ups.", 403);
  if (!domainAllowed(s, email)) throw new CloudError(`Only ${s.allowedDomains.map((d) => "@" + d).join(", ")} email addresses can use this app.`, 403);
}

async function codes(projectId: string) {
  const db = openDatabase(projectId);
  await db.ensure(`CREATE TABLE IF NOT EXISTS _forge_auth_codes (
    email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)`);
  return db;
}

const hash = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

/** Email a six-digit sign-in code. Answers the same whether or not the account exists. */
export async function sendSignInCode(projectId: string, cfg: CloudConfig, rawEmail: string, appName: string) {
  const s = authSettings(cfg);
  if (!s.emailCode) throw new CloudError("Sign-in by email code is turned off for this app.", 403);
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new CloudError("Enter a valid email address.");
  if (!domainAllowed(s, email)) throw new CloudError(`Only ${s.allowedDomains.map((d) => "@" + d).join(", ")} email addresses can use this app.`, 403);
  const db = await codes(projectId);
  const prev = await db.get<{ sent_at: number }>("SELECT sent_at FROM _forge_auth_codes WHERE email = ?", [email]);
  if (prev && Date.now() - prev.sent_at < 30_000) throw new CloudError("A code was just sent. Wait 30 seconds before asking again.", 429);
  const exists = !!(await db.get("SELECT 1 FROM auth_users WHERE email = ?", [email]));
  // Nobody to sign in and nobody may sign up: send nothing, but don't reveal that.
  if (!exists && !s.signups) return { sent: true };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await db.run(
    `INSERT INTO _forge_auth_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`,
    [email, hash(code), Date.now() + CODE_TTL_MS, Date.now()],
  );
  await deliver(
    projectId,
    cfg,
    {
      to: email,
      subject: `Your ${appName} sign-in code: ${code}`,
      text: `Your sign-in code for ${appName} is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.`,
      html: null,
    },
    null,
  );
  return { sent: true };
}

/** Check a code and return a session; a new account is made if sign-ups are open. */
export async function verifySignInCode(projectId: string, cfg: CloudConfig, rawEmail: string, code: string) {
  const s = authSettings(cfg);
  if (!s.emailCode) throw new CloudError("Sign-in by email code is turned off for this app.", 403);
  const email = rawEmail.trim().toLowerCase();
  const db = await codes(projectId);
  const row = await db.get<{ code_hash: string; expires_at: number; attempts: number }>(
    "SELECT code_hash, expires_at, attempts FROM _forge_auth_codes WHERE email = ?",
    [email],
  );
  if (!row || row.expires_at < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    throw new CloudError("That code has expired. Ask for a new one.", 401);
  }
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hash(String(code).trim())));
  if (!ok) {
    await db.run("UPDATE _forge_auth_codes SET attempts = attempts + 1 WHERE email = ?", [email]);
    throw new CloudError("That code isn't right.", 401);
  }
  await db.run("DELETE FROM _forge_auth_codes WHERE email = ?", [email]);
  return sessionFor(projectId, cfg, email, { create: s.signups });
}
