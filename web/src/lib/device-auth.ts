import { randomBytes, randomInt } from "node:crypto";
import { db } from "./db";
import { recordLogin } from "./login-log";

/**
 * Signing in another device (the desktop app, a CLI) by approval: the device
 * asks for a code, shows it, and polls; a signed-in person enters the code in
 * the browser, sees which device is asking, and approves or denies. On
 * approval the device gets a session of its own, handed over exactly once.
 */
export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_DAYS = 30;
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels or look-alikes

export class DeviceAuthError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

function userCode() {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

export async function startDeviceAuth(clientName: string) {
  const name = clientName.trim().slice(0, 60) || "A device";
  const row = await db.deviceAuth.create({
    data: { deviceCode: randomBytes(32).toString("base64url"), userCode: userCode(), clientName: name, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  return { deviceCode: row.deviceCode, userCode: row.userCode, expiresAt: row.expiresAt.toISOString() };
}

export async function findPending(code: string) {
  const row = await db.deviceAuth.findUnique({ where: { userCode: normalizeCode(code) } });
  if (!row || row.status !== "pending" || row.expiresAt < new Date()) return null;
  return { userCode: row.userCode, clientName: row.clientName, createdAt: row.createdAt.toISOString() };
}

export async function decide(code: string, userId: string, approve: boolean) {
  const row = await db.deviceAuth.findUnique({ where: { userCode: normalizeCode(code) } });
  if (!row || row.status !== "pending" || row.expiresAt < new Date()) {
    throw new DeviceAuthError("That code has expired or was already used. Start again on the device.", 404);
  }
  if (!approve) {
    await db.deviceAuth.update({ where: { id: row.id }, data: { status: "denied", userId } });
    return { approved: false, clientName: row.clientName };
  }
  const sessionToken = randomBytes(32).toString("hex");
  await db.session.create({ data: { sessionToken, userId, expires: new Date(Date.now() + SESSION_DAYS * 86_400_000) } });
  await recordLogin(userId, "device");
  await db.deviceAuth.update({ where: { id: row.id }, data: { status: "approved", userId, sessionToken } });
  return { approved: true, clientName: row.clientName };
}

/** The device's poll: pending, denied, expired, or approved with its session (once). */
export async function poll(deviceCode: string) {
  const row = await db.deviceAuth.findUnique({ where: { deviceCode } });
  if (!row) return { status: "expired" as const };
  if (row.status === "approved" && row.sessionToken) {
    await db.deviceAuth.update({ where: { id: row.id }, data: { status: "consumed", sessionToken: null } });
    return { status: "approved" as const, sessionToken: row.sessionToken };
  }
  if (row.status === "denied") return { status: "denied" as const };
  if (row.status === "consumed" || row.expiresAt < new Date()) return { status: "expired" as const };
  return { status: "pending" as const };
}
