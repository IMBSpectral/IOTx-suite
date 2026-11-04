/**
 * Two-step verification and branding: turning it on with an authenticator
 * code, recovery codes, other sessions held at the second step until they
 * verify, wrong and reused codes refused, turning it off; branding saved by
 * a platform admin and refused to others.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle38.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "../src/lib/db";
import { totp } from "../src/lib/totp";

const BASE = "http://localhost:3000";
const [token, usersFile] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(usersFile, "utf8")) as Record<string, string>;
const DEV = `authjs.session-token=${token}`;
const OUTSIDER = `authjs.session-token=${users["outsider@localhost"]}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown, cookie = DEV) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const extra: string[] = [];
async function newSession() {
  const t = crypto.randomUUID();
  await db.session.create({ data: { sessionToken: t, userId: dev.id, expires: new Date(Date.now() + 3600_000) } });
  extra.push(t);
  return `authjs.session-token=${t}`;
}
const brandFile = `${process.env.PROJECTS_ROOT}/_forge/branding.json`;
const brandBefore = fs.existsSync(brandFile) ? fs.readFileSync(brandFile, "utf8") : null;

try {
  // ── Two-step verification
  check("starts off", (await call("/api/mfa")).json.enabled === false);
  const setup = (await call("/api/mfa", { action: "setup" })).json as { secret: string; otpauth: string; qr: string };
  check("setup gives a QR code and a key", setup.qr?.startsWith("data:image/png") && /^otpauth:\/\/totp\//.test(setup.otpauth) && setup.secret?.length > 20);
  const secret = setup.secret.replace(/\s/g, "");
  check("a wrong first code doesn't turn it on", (await call("/api/mfa", { action: "enable", code: "000000" })).status === 400 && (await call("/api/mfa")).json.enabled === false);
  const on = await call("/api/mfa", { action: "enable", code: totp(secret) });
  const recovery = on.json.recoveryCodes as string[];
  check("the right code turns it on and gives 10 recovery codes", on.status === 200 && recovery?.length === 10);
  check("the session that turned it on keeps working", (await call("/api/workspace")).status === 200);

  const other = await newSession();
  check("another session is held at the second step", (await call("/api/workspace", undefined, other)).status === 401);
  const page = await fetch(`${BASE}/home`, { headers: { cookie: other }, redirect: "manual" });
  check("and pages send it to /login/mfa", (page.headers.get("location") ?? "").includes("/login/mfa"), page.headers.get("location") ?? "");
  check("a wrong code is refused", (await call("/api/mfa", { action: "verify", code: "123456" }, other)).status === 400);
  check("the right code lets it in", (await call("/api/mfa", { action: "verify", code: totp(secret) }, other)).status === 200 && (await call("/api/workspace", undefined, other)).status === 200);

  const third = await newSession();
  check("a recovery code works once", (await call("/api/mfa", { action: "verify", code: recovery[0] }, third)).status === 200);
  const fourth = await newSession();
  check("and can't be used again", (await call("/api/mfa", { action: "verify", code: recovery[0] }, fourth)).status === 400);
  check("one recovery code is used up", (await call("/api/mfa")).json.recoveryLeft === 9);
  check("verify does nothing for a session that isn't waiting", (await call("/api/mfa", { action: "verify", code: totp(secret) })).status === 400);

  const off = await call("/api/mfa", { action: "disable", code: totp(secret) });
  check("it can be turned off with a code", off.status === 200 && (await call("/api/mfa")).json.enabled === false);
  check("then every session works again", (await call("/api/workspace", undefined, fourth)).status === 200);

  // ── Branding
  const saved = await call("/api/brand", { name: "Acme Works", shortName: "Acme", mark: "AW", colorFrom: "#112233", colorTo: "not-a-colour" });
  check("a platform admin can rename the platform", saved.status === 200 && saved.json.brand?.name === "Acme Works" && saved.json.brand.colorTo === "#a855f7");
  const html = await (await fetch(`${BASE}/login`)).text();
  check("pages use the new name", html.includes("<title>Acme Works</title>"));
  check("others can't change branding", (await call("/api/brand", { name: "Hacked" }, OUTSIDER)).status === 403);
  check("the brand is public to read", (await (await fetch(`${BASE}/api/brand`)).json()).brand.name === "Acme Works");
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  await db.user.update({ where: { id: dev.id }, data: { mfaEnabledAt: null } }).catch(() => undefined);
  await db.session.deleteMany({ where: { sessionToken: { in: extra } } });
  if (brandBefore === null) fs.rmSync(brandFile, { force: true });
  else fs.writeFileSync(brandFile, brandBefore);
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
