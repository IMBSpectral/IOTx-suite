import crypto from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { BASE, SESSION_COOKIE, SUITE_PUBLIC_URL, SUITE_URL, WORKSPACE_PUBLIC_URL } from "./env";
import { noteAiContext } from "./ai-meter";

/**
 * Single sign-on with the IOTx Suite. Workspace never keeps its own accounts:
 * a page without a session is sent to the suite's pass URL, the callback posts
 * the pass here, the suite verifies it (POST /api/iotx/verify) and we keep an
 * httpOnly session cookie scoped to /workspace. Permission decisions for every
 * Workspace key come from the same verify call and are refreshed every 60s
 * while the latest pass is still valid; pages bounce through the suite for a
 * fresh pass when it has expired and the decisions are stale.
 */

export type AppId = "calendar" | "tasks" | "teamchat" | "meetings";
export const APP_PATH: Record<AppId, string> = { calendar: "/calendar", tasks: "/tasks", teamchat: "/chat", meetings: "/meet" };

export const PERM_KEYS = [
  "calendar.open", "calendar.create", "calendar.google", "calendar.team",
  "tasks.open", "tasks.project.create", "tasks.create", "tasks.assign", "tasks.delete",
  "teamchat.open", "teamchat.channel.create", "teamchat.private", "teamchat.ai", "teamchat.admin",
  // Meet (suite app id "meetings"; switch keys must start with the app id).
  "meetings.open", "meetings.create", "meetings.guests", "meetings.record", "meetings.ai_notes",
] as const;
export type PermKey = (typeof PERM_KEYS)[number];

const PERMS_TTL_MS = 60_000;
const SESSION_DAYS = 7;

type Claims = { sub: string; email: string; name: string | null; ws: string; app: string; owner: boolean; exp?: number };

export async function verifyWithSuite(token: string): Promise<{ claims: Claims; decisions: Record<string, boolean> } | null> {
  try {
    const r = await fetch(`${SUITE_URL}/api/iotx/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, keys: PERM_KEYS }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { valid?: boolean; claims?: Claims; decisions?: Record<string, boolean> };
    if (!d.valid || !d.claims) return null;
    return { claims: d.claims, decisions: d.decisions ?? {} };
  } catch {
    return null;
  }
}

/** Sign in with a pass: verify it, remember the person, open a session. */
export async function signIn(pass: string, tz?: string) {
  const v = await verifyWithSuite(pass);
  if (!v) return null;
  const { claims, decisions } = v;
  const zone = tz && isZone(tz) ? tz : undefined;
  await db.user.upsert({
    where: { id: claims.sub },
    create: { id: claims.sub, email: claims.email, name: claims.name, ...(zone ? { tz: zone } : {}) },
    update: { email: claims.email, name: claims.name, ...(zone ? { tz: zone } : {}) },
  });
  await db.member.upsert({ where: { ws_userId: { ws: claims.ws, userId: claims.sub } }, create: { ws: claims.ws, userId: claims.sub }, update: { seenAt: new Date() } });
  const id = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await db.session.create({
    data: {
      id,
      userId: claims.sub,
      ws: claims.ws,
      pass,
      passExp: new Date((claims.exp ?? Math.floor(Date.now() / 1000) + 300) * 1000),
      perms: decisions,
      permsAt: now,
      owner: !!claims.owner,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
    },
  });
  await ensurePersonalCalendar(claims.ws, claims.sub, claims.name ?? claims.email);
  return { id, claims };
}

export function isZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function ensurePersonalCalendar(ws: string, userId: string, name: string) {
  const c = await db.calendar.findFirst({ where: { ws, kind: "personal", ownerId: userId, primary: true } });
  if (c) return c;
  return db.calendar.create({ data: { ws, kind: "personal", ownerId: userId, name: "My calendar", color: "#4f46e5", createdBy: userId } });
}

export type Me = {
  sid: string;
  userId: string;
  ws: string;
  name: string;
  email: string;
  tz: string;
  owner: boolean;
  perms: Record<string, boolean>;
  /** The pass has expired and decisions are older than 60s: pages should refresh through the suite. */
  stale: boolean;
  /** A Chat guest from outside the company: only their channels, no other apps. */
  guest: boolean;
};

/** The signed-in person, or null. Refreshes permission decisions every 60s while possible. */
export async function getMe(): Promise<Me | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  return meFromSid(sid);
}

export async function meFromSid(sid: string): Promise<Me | null> {
  const s = await db.session.findUnique({ where: { id: sid } });
  if (!s || s.expiresAt < new Date()) return null;
  if (s.guest) return guestMe(s);
  let perms = s.perms as Record<string, boolean>;
  let permsAt = s.permsAt;
  const old = Date.now() - permsAt.getTime() > PERMS_TTL_MS;
  if (old && s.passExp > new Date()) {
    const v = await verifyWithSuite(s.pass);
    if (v) {
      perms = v.decisions;
      permsAt = new Date();
      await db.session.update({ where: { id: sid }, data: { perms, permsAt } });
    }
  }
  const u = await db.user.findUnique({ where: { id: s.userId } });
  if (!u) return null;
  noteAiContext({ userId: s.userId, workspaceId: s.ws });
  return {
    sid,
    userId: s.userId,
    ws: s.ws,
    name: u.name ?? u.email,
    email: u.email,
    tz: u.tz,
    owner: s.owner,
    perms,
    stale: Date.now() - permsAt.getTime() > PERMS_TTL_MS && s.passExp <= new Date(),
    guest: false,
  };
}

/** Guests sign in with an emailed link, not the suite: fixed Chat-only permissions while the invitation stands. */
export const GUEST_PERMS: Record<string, boolean> = { "teamchat.open": true };
async function guestMe(s: { id: string; userId: string; ws: string }): Promise<Me | null> {
  const g = await db.chatGuest.findFirst({ where: { ws: s.ws, userId: s.userId } });
  if (!g || g.deactivatedAt || (g.expiresAt && g.expiresAt < new Date())) return null;
  const u = await db.user.findUnique({ where: { id: s.userId } });
  if (!u) return null;
  return { sid: s.id, userId: s.userId, ws: s.ws, name: u.name ?? u.email, email: u.email, tz: u.tz, owner: false, perms: GUEST_PERMS, stale: false, guest: true };
}

/** The suite's pass URL that comes back to this app's callback. */
export function passUrl(app: AppId, next: string) {
  const cb = `${WORKSPACE_PUBLIC_URL}${BASE}/auth/callback?next=${encodeURIComponent(next)}`;
  return `${SUITE_PUBLIC_URL}/api/iotx/pass?app=${app}&redirect=${encodeURIComponent(cb)}`;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

/** For API routes: the signed-in person, else 401. With `key`, 403 unless the suite allows it. */
export async function requireMe(key?: PermKey | PermKey[]) {
  const me = await getMe();
  if (!me) throw new HttpError(401, "Sign in through IOTx first.");
  for (const k of key === undefined ? [] : Array.isArray(key) ? key : [key]) {
    if (!me.perms[k]) throw new HttpError(403, "Your role doesn't allow this. Ask an admin to turn it on.", { key: k });
  }
  return me;
}

export const can = (me: Me, key: PermKey) => !!me.perms[key];
