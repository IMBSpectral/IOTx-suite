import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import QRCode from "qrcode";
import { db } from "./db";
import { open, seal, type SecretBox } from "./secret-box";
import { newSecret, otpauthUrl, verifyTotp } from "./totp";
import { getBrand } from "./brand";

/**
 * Two-step verification for platform accounts. After Google (or any)
 * sign-in, a person who turned it on must also enter a code from their
 * authenticator app, or one of their recovery codes, before the session works.
 * Until then the session is "pending" (see the session callback in auth.ts).
 */
const PURPOSE = "mfa-totp";
const RECOVERY_COUNT = 10;

const hash = (code: string) => crypto.createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");

function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const s = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

// Wrong codes: at most 5 per account per 10 minutes.
const failures = new Map<string, number[]>();
function limited(userId: string) {
  const now = Date.now();
  const recent = (failures.get(userId) ?? []).filter((t) => now - t < 10 * 60_000);
  failures.set(userId, recent);
  return recent.length >= 5;
}
const fail = (userId: string) => failures.set(userId, [...(failures.get(userId) ?? []), Date.now()]);

export class MfaError extends Error {}

export async function mfaStatus(userId: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabledAt: true, mfaRecovery: true } });
  return { enabled: !!u.mfaEnabledAt, enabledAt: u.mfaEnabledAt, recoveryLeft: Array.isArray(u.mfaRecovery) ? u.mfaRecovery.length : 0 };
}

/** Step 1: a fresh secret, its QR code and the key to type in by hand. Not active until confirmed. */
export async function beginSetup(userId: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, mfaEnabledAt: true } });
  if (u.mfaEnabledAt) throw new MfaError("Two-step verification is already on.");
  const secret = newSecret();
  await db.user.update({ where: { id: userId }, data: { mfaSecret: seal(PURPOSE, secret) } });
  const url = otpauthUrl(getBrand().name, u.email ?? userId, secret);
  return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), otpauth: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
}

function secretOf(box: unknown) {
  if (!box || typeof box !== "object") return null;
  try {
    return open(PURPOSE, box as SecretBox);
  } catch {
    return null;
  }
}

/** Check a six-digit code or a recovery code (which is then used up). */
async function check(userId: string, code: string, allowRecovery: boolean) {
  if (limited(userId)) throw new MfaError("Too many wrong codes. Wait 10 minutes and try again.");
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaSecret: true, mfaRecovery: true } });
  const secret = secretOf(u.mfaSecret);
  if (secret && verifyTotp(secret, code)) return true;
  if (allowRecovery && Array.isArray(u.mfaRecovery)) {
    const h = hash(code);
    const left = (u.mfaRecovery as string[]).filter((x) => x !== h);
    if (left.length < u.mfaRecovery.length) {
      await db.user.update({ where: { id: userId }, data: { mfaRecovery: left } });
      return true;
    }
  }
  fail(userId);
  return false;
}

/** Step 2: the first code proves the app is set up. Turns it on and returns the recovery codes (shown once). */
export async function confirmSetup(userId: string, code: string, sessionToken: string | null) {
  if (!(await check(userId, code, false))) throw new MfaError("That code didn't match. Check the time on your phone and try again.");
  const codes = newRecoveryCodes();
  await db.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date(), mfaRecovery: codes.map(hash) } });
  // The session that turned it on stays signed in; every other session must verify.
  await db.session.updateMany({ where: { userId, NOT: { sessionToken: sessionToken ?? "" } }, data: { mfaAt: null } });
  if (sessionToken) await db.session.updateMany({ where: { sessionToken, userId }, data: { mfaAt: new Date() } });
  return codes;
}

export async function disable(userId: string, code: string) {
  if (!(await check(userId, code, true))) throw new MfaError("That code didn't match.");
  await db.user.update({ where: { id: userId }, data: { mfaEnabledAt: null, mfaSecret: Prisma.DbNull, mfaRecovery: Prisma.DbNull } });
}

export async function regenerateRecovery(userId: string, code: string) {
  if (!(await check(userId, code, false))) throw new MfaError("That code didn't match.");
  const codes = newRecoveryCodes();
  await db.user.update({ where: { id: userId }, data: { mfaRecovery: codes.map(hash) } });
  return codes;
}

/** Sign-in step: a pending session becomes a full one. */
export async function verifySession(userId: string, sessionToken: string, code: string) {
  const s = await db.session.findUnique({ where: { sessionToken } });
  if (!s || s.userId !== userId || s.expires < new Date()) throw new MfaError("Your sign-in expired. Sign in again.");
  if (!(await check(userId, code, true))) throw new MfaError("That code didn't match. Try the newest code in your app.");
  await db.session.update({ where: { sessionToken }, data: { mfaAt: new Date() } });
}
