import crypto from "node:crypto";
import { getBrand } from "./brand";
import { db } from "./db";
import { CloudError, getCloud, sessionFor, type CloudConfig } from "./cloud";
import { authSettings } from "./cloud-auth";
import { siteUrl } from "./publish";
import { sandboxState } from "./sandbox";

/**
 * "Continue with Forge": people sign in to an app built on Forge with their
 * Forge account. The app sends them to Forge's consent page; Forge hands back
 * a single-use code (five minutes); the app's Cloud API trades it for a normal
 * app session. The app only ever learns the person's email address.
 */

const CODE_TTL_MS = 5 * 60_000;
// provider: which sign-in produced the code (the platform account, or Google).
const codes = new Map<string, { projectId: string; email: string; redirectOrigin: string; expires: number; provider: "forge" | "google" }>();

/** Where an app may send people back to: its preview, its published site, its custom domain. */
export async function allowedRedirect(projectId: string, raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const p = await db.project.findUnique({ where: { id: projectId }, select: { subdomain: true, customDomain: true, deletedAt: true } });
  if (!p || p.deletedAt) return null;
  const origins = new Set([new URL(siteUrl(p.subdomain)).origin]);
  if (p.customDomain) origins.add(`https://${p.customDomain}`);
  const s = sandboxState(projectId);
  if (s.status === "ready") {
    origins.add(`http://127.0.0.1:${s.port}`);
    origins.add(`http://localhost:${s.port}`);
  }
  return origins.has(u.origin) ? u : null;
}

/** The consent page approved: a code for the app to exchange. */
export async function issueCode(projectId: string, userId: string, redirect: URL) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled || !authSettings(cfg).forge) throw new CloudError(`This app doesn't offer Continue with ${getBrand().name}.`, 403);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const code = `fgc_${crypto.randomBytes(24).toString("base64url")}`;
  codes.set(code, { projectId, email: user.email.toLowerCase(), redirectOrigin: redirect.origin, expires: Date.now() + CODE_TTL_MS, provider: "forge" });
  for (const [k, v] of codes) if (v.expires < Date.now()) codes.delete(k);
  return code;
}

/** Google confirmed this (verified) address for an app's user: a code for the app to exchange. */
export async function issueGoogleCode(projectId: string, email: string, redirect: URL) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled || !authSettings(cfg).google) throw new CloudError("This app doesn't offer Continue with Google.", 403);
  const code = `fgc_${crypto.randomBytes(24).toString("base64url")}`;
  codes.set(code, { projectId, email: email.toLowerCase(), redirectOrigin: redirect.origin, expires: Date.now() + CODE_TTL_MS, provider: "google" });
  return code;
}

/** The app trades the code for a session (once). Sign-up and domain rules still apply. */
export async function exchangeCode(projectId: string, cfg: CloudConfig, code: string, origin: string | null) {
  const c = codes.get(code);
  codes.delete(code);
  if (!c || c.projectId !== projectId || c.expires < Date.now()) throw new CloudError("That sign-in link has expired. Try again.", 401);
  // A code is only good for the app address it was issued to.
  if (origin && origin !== c.redirectOrigin) throw new CloudError("That sign-in link was made for another address.", 401);
  const s = authSettings(cfg);
  if (c.provider === "forge" && !s.forge) throw new CloudError(`This app doesn't offer Continue with ${getBrand().name}.`, 403);
  if (c.provider === "google" && !s.google) throw new CloudError("This app doesn't offer Continue with Google.", 403);
  if (s.allowedDomains.length && !s.allowedDomains.includes(c.email.split("@")[1] ?? "")) {
    throw new CloudError(`Only ${s.allowedDomains.map((d) => "@" + d).join(", ")} email addresses can use this app.`, 403);
  }
  return sessionFor(projectId, cfg, c.email, { create: s.signups });
}
