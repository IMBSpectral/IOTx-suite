import { db } from "./db";
import { publish } from "./bus";

/**
 * Who is online in Chat: open /api/stream connections per person (one
 * process), plus their own away / do-not-disturb choice in User.chatPrefs.
 */
export type ChatPrefs = { status?: string; emoji?: string; until?: string | null; away?: boolean; dndUntil?: string | null; email?: boolean; desktop?: boolean; push?: boolean };
export type Presence = "active" | "away" | "dnd";

const g = globalThis as unknown as { __iotxOnline?: Map<string, number> };
const online = g.__iotxOnline ?? (g.__iotxOnline = new Map());
const key = (ws: string, userId: string) => `${ws}:${userId}`;

export const isOnline = (ws: string, userId: string) => (online.get(key(ws, userId)) ?? 0) > 0;

export function prefsOf(raw: unknown): ChatPrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as ChatPrefs;
  // A custom status with an end time clears itself.
  if (p.until && new Date(p.until) <= new Date()) return { ...p, status: "", emoji: "", until: null };
  return p;
}
export const inDnd = (p: ChatPrefs, now = new Date()) => !!p.dndUntil && new Date(p.dndUntil) > now;

export function presenceOf(ws: string, userId: string, p: ChatPrefs): Presence {
  if (inDnd(p)) return "dnd";
  return !p.away && isOnline(ws, userId) ? "active" : "away";
}

async function announce(ws: string, userId: string) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { chatPrefs: true } });
  const p = prefsOf(u?.chatPrefs);
  publish(`ws:${ws}`, { type: "presence", userId, presence: presenceOf(ws, userId, p), status: p.status ?? "", emoji: p.emoji ?? "" });
}

/** Called by the stream route when a connection opens and closes. */
export function connected(ws: string, userId: string) {
  const k = key(ws, userId);
  const n = (online.get(k) ?? 0) + 1;
  online.set(k, n);
  if (n === 1) void announce(ws, userId).catch(() => {});
}
export function disconnected(ws: string, userId: string) {
  const k = key(ws, userId);
  const n = Math.max(0, (online.get(k) ?? 1) - 1);
  if (n) online.set(k, n);
  else online.delete(k);
  if (!n) void announce(ws, userId).catch(() => {});
}

/** Everyone in the workspace: { userId: { presence, status, emoji } }. */
export async function presenceMap(ws: string) {
  const ms = await db.member.findMany({ where: { ws }, select: { userId: true } });
  const us = await db.user.findMany({ where: { id: { in: ms.map((m) => m.userId) } }, select: { id: true, chatPrefs: true } });
  const out: Record<string, { presence: Presence; status: string; emoji: string }> = {};
  for (const u of us) {
    const p = prefsOf(u.chatPrefs);
    out[u.id] = { presence: presenceOf(ws, u.id, p), status: p.status ?? "", emoji: p.emoji ?? "" };
  }
  return out;
}

export async function savePrefs(ws: string, userId: string, input: Record<string, unknown>) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { chatPrefs: true } });
  const p = prefsOf(u?.chatPrefs);
  const date = (v: unknown) => (v ? (isNaN(new Date(String(v)).getTime()) ? null : new Date(String(v)).toISOString()) : null);
  if (input.status !== undefined) p.status = String(input.status ?? "").slice(0, 100);
  if (input.emoji !== undefined) p.emoji = String(input.emoji ?? "").slice(0, 16);
  if (input.until !== undefined) p.until = date(input.until);
  if (input.away !== undefined) p.away = !!input.away;
  if (input.dndUntil !== undefined) p.dndUntil = date(input.dndUntil);
  if (input.email !== undefined) p.email = !!input.email;
  if (input.desktop !== undefined) p.desktop = !!input.desktop;
  if (input.push !== undefined) p.push = !!input.push;
  await db.user.update({ where: { id: userId }, data: { chatPrefs: p } });
  await announce(ws, userId);
  return { ...p, presence: presenceOf(ws, userId, p) };
}
