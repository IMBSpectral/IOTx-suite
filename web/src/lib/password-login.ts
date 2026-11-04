import crypto from "node:crypto";
import { db } from "./db";
import { hashPassword, verifyPassword } from "./passwords";
import { recordLogin } from "./login-log";

/**
 * Email + password sign-in, beside emailed links and company single sign-on.
 * A correct password opens the same kind of database session Auth.js uses, so
 * two-step verification (mfaAt stays empty until the code is given), login
 * history and roles all behave as for any other sign-in. Wrong attempts are
 * limited per address and per IP.
 */

const WINDOW = 15 * 60_000;
const MAX_TRIES = 10;
const G = globalThis as { __pwTries?: Map<string, { n: number; until: number }> };
const tries = (G.__pwTries ??= new Map());

function limited(key: string) {
  const t = tries.get(key);
  return !!t && t.until > Date.now() && t.n >= MAX_TRIES;
}
function failed(key: string) {
  const t = tries.get(key);
  const now = Date.now();
  tries.set(key, t && t.until > now ? { n: t.n + 1, until: t.until } : { n: 1, until: now + WINDOW });
  if (tries.size > 10_000) tries.clear();
}

export const MIN_PASSWORD = 8;

/** Check a password and open a session: { sessionToken, expires } or an error to show. */
export async function passwordSignIn(emailRaw: string, password: string, ip: string) {
  const email = emailRaw.trim().toLowerCase();
  if (!email || !password) return { error: "Enter your email and password." } as const;
  if (limited(`e:${email}`) || limited(`i:${ip}`)) return { error: "Too many attempts. Wait 15 minutes, or sign in with an emailed link." } as const;
  const user = await db.user.findUnique({ where: { email }, select: { id: true, passwordHash: true, deletionScheduledAt: true } });
  // Same answer and similar time whether or not the account exists.
  const ok = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : (await hashPassword(password), false);
  if (!user || !ok) {
    failed(`e:${email}`);
    failed(`i:${ip}`);
    return { error: "That email and password don't match." } as const;
  }
  tries.delete(`e:${email}`);
  const sessionToken = crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 86_400_000);
  await db.session.create({ data: { sessionToken, userId: user.id, expires } });
  await recordLogin(user.id, "password");
  return { sessionToken, expires } as const;
}

/** Set (or replace) someone's password. Returns an error message, or null when done. */
export async function setPassword(userId: string, password: string) {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "That password is too long.";
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password), passwordSetAt: new Date() } });
  return null;
}
