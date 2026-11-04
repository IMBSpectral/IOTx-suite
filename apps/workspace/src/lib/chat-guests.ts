import crypto from "node:crypto";
import type { ChatGuest } from "@prisma/client";
import { db } from "./db";
import { publish } from "./bus";
import { GUEST_PERMS, HttpError, isZone, type Me } from "./auth";
import { BASE, EMAIL_ORIGIN } from "./env";
import { bad, str } from "./http";
import { isAdmin } from "./chat";
import { sendMail } from "./cal-mail";

/**
 * Chat guests: people from other companies, invited by a Chat admin into
 * chosen channels. They have no suite account: an emailed link (one use,
 * 7 days) signs them in to Chat only (fixed teamchat.open; no other apps,
 * no channel browser, no workspace directory beyond their channels, DMs only
 * with people they share a channel with). Admins can change their channels,
 * set an end date, deactivate them (signs them out everywhere) or resend.
 * A guest who has lost their session asks for a new link by email at
 * /workspace/chat/guest (no answer reveals whether an address is a guest).
 */

const LINK_DAYS = 7;
const SESSION_DAYS = 30;
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const email = (s: unknown) => {
  const e = String(s ?? "").trim().toLowerCase().slice(0, 200);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
};

const adminOnly = (me: Me) => {
  if (!isAdmin(me)) throw new HttpError(403, "Only Chat admins can manage guests.");
};

async function validChannels(ws: string, ids: unknown) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 50);
  const chs = await db.channel.findMany({ where: { ws, id: { in: list }, kind: { not: "dm" }, archivedAt: null } });
  if (chs.length !== list.length) bad("A channel couldn't be found (or is archived).");
  return chs;
}

async function wsName(ws: string, inviter: string) {
  const u = await db.user.findUnique({ where: { id: inviter } });
  return u?.name || u?.email || "A colleague";
}

async function newLink(g: ChatGuest) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.chatGuest.update({ where: { id: g.id }, data: { tokenHash: hash(token), tokenExp: new Date(Date.now() + LINK_DAYS * 86400_000) } });
  return `${EMAIL_ORIGIN}${BASE}/chat/guest/${token}`;
}

/** Sync a guest's channel memberships to their invitation (once they have an account). */
async function syncChannels(g: ChatGuest) {
  if (!g.userId) return;
  const have = await db.channelMember.findMany({ where: { userId: g.userId, channel: { kind: { not: "dm" } } } });
  for (const id of g.channelIds) if (!have.some((h) => h.channelId === id)) {
    const ch = await db.channel.findUnique({ where: { id } });
    if (!ch || ch.archivedAt) continue;
    await db.channelMember.create({ data: { channelId: id, userId: g.userId } });
    await db.message.create({ data: { ws: g.ws, channelId: id, userId: g.userId, body: "joined as a guest", system: true } });
    publish(`ws:${g.ws}`, { type: "channel", channelId: id, kind: ch.kind });
  }
  for (const h of have) if (!g.channelIds.includes(h.channelId)) {
    await db.channelMember.delete({ where: { channelId_userId: { channelId: h.channelId, userId: g.userId } } });
    publish(`ws:${g.ws}`, { type: "channel", channelId: h.channelId });
  }
}

function guestDto(g: ChatGuest, names: Map<string, string>) {
  return {
    id: g.id, email: g.email, name: g.name, userId: g.userId, channelIds: g.channelIds,
    channels: g.channelIds.map((id) => names.get(id)).filter(Boolean),
    invitedBy: g.invitedBy, createdAt: g.createdAt, acceptedAt: g.acceptedAt, expiresAt: g.expiresAt,
    status: g.deactivatedAt ? "deactivated" : g.expiresAt && g.expiresAt < new Date() ? "expired" : g.acceptedAt ? "active" : "invited",
  };
}

export async function listGuests(me: Me) {
  adminOnly(me);
  const rows = await db.chatGuest.findMany({ where: { ws: me.ws }, orderBy: { createdAt: "desc" } });
  const chs = await db.channel.findMany({ where: { id: { in: rows.flatMap((r) => r.channelIds) } }, select: { id: true, name: true } });
  const names = new Map(chs.map((c) => [c.id, c.name]));
  return rows.map((r) => guestDto(r, names));
}

export async function inviteGuest(me: Me, b: { email?: unknown; name?: unknown; channelIds?: unknown; expiresAt?: unknown; note?: unknown }) {
  adminOnly(me);
  const to = email(b.email);
  if (!to) bad("Type the guest's email address.");
  const same = await db.user.findMany({ where: { email: { equals: to, mode: "insensitive" }, NOT: { id: { startsWith: "guest_" } } }, select: { id: true } });
  if (same.length && (await db.member.findFirst({ where: { ws: me.ws, userId: { in: same.map((u) => u.id) } } }))) bad("That person is already in your workspace.");
  const chs = await validChannels(me.ws, b.channelIds);
  if (!chs.length) bad("Pick at least one channel for the guest.");
  const expiresAt = b.expiresAt ? new Date(String(b.expiresAt)) : null;
  if (expiresAt && (isNaN(expiresAt.getTime()) || expiresAt < new Date())) bad("The end date must be in the future.");
  if ((await db.chatGuest.count({ where: { ws: me.ws, deactivatedAt: null } })) >= 500) bad("A workspace can have up to 500 guests.");
  const g = await db.chatGuest.upsert({
    where: { ws_email: { ws: me.ws, email: to } },
    create: { ws: me.ws, email: to, name: str(b.name, 80), channelIds: chs.map((c) => c.id), invitedBy: me.userId, expiresAt },
    update: { channelIds: chs.map((c) => c.id), invitedBy: me.userId, expiresAt, deactivatedAt: null, ...(b.name ? { name: str(b.name, 80) } : {}) },
  });
  await syncChannels(g);
  const link = await newLink(g);
  const who = await wsName(me.ws, me.userId);
  const note = str(b.note, 500);
  await sendMail({
    to,
    subject: `${who} invited you to chat in ${chs.map((c) => `#${c.name}`).join(", ")}`,
    text: `${who} (${me.email}) invited you to join ${chs.length === 1 ? "a channel" : `${chs.length} channels`} as a guest: ${chs.map((c) => `#${c.name}`).join(", ")}.${note ? `\n\n"${note}"` : ""}\n\nJoin: ${link}\n\nThe link works once and for ${LINK_DAYS} days. As a guest you only see these channels.`,
    fromName: "IOTx Chat",
  });
  const chNames = new Map(chs.map((c) => [c.id, c.name]));
  return guestDto(await db.chatGuest.findUniqueOrThrow({ where: { id: g.id } }), chNames);
}

export async function updateGuest(me: Me, id: string, b: { channelIds?: unknown; expiresAt?: unknown; deactivated?: unknown; resend?: unknown; name?: unknown }) {
  adminOnly(me);
  let g = await db.chatGuest.findUnique({ where: { id } });
  if (!g || g.ws !== me.ws) throw new HttpError(404, "Guest not found");
  const data: Record<string, unknown> = {};
  if (b.channelIds !== undefined) {
    const chs = await validChannels(me.ws, b.channelIds);
    if (!chs.length) bad("A guest needs at least one channel. Deactivate them instead.");
    data.channelIds = chs.map((c) => c.id);
  }
  if (b.expiresAt !== undefined) {
    const d = b.expiresAt ? new Date(String(b.expiresAt)) : null;
    if (d && isNaN(d.getTime())) bad("That end date isn't valid.");
    data.expiresAt = d;
  }
  if (b.name !== undefined) data.name = str(b.name, 80);
  if (b.deactivated !== undefined) data.deactivatedAt = b.deactivated ? new Date() : null;
  g = await db.chatGuest.update({ where: { id }, data });
  if (g.deactivatedAt && g.userId) {
    // Signed out everywhere; push stops too.
    await db.session.deleteMany({ where: { userId: g.userId } });
    await db.pushSub.deleteMany({ where: { userId: g.userId } });
  } else await syncChannels(g);
  if (b.resend && !g.deactivatedAt) {
    const link = await newLink(g);
    await sendMail({ to: g.email, subject: "Your link to IOTx Chat", text: `Here is a new link to sign in to Chat as a guest:\n\n${link}\n\nIt works once and for ${LINK_DAYS} days.`, fromName: "IOTx Chat" });
  }
  const chs = await db.channel.findMany({ where: { id: { in: g.channelIds } }, select: { id: true, name: true } });
  return guestDto(g, new Map(chs.map((c) => [c.id, c.name])));
}

/** The invitation behind a link (for the join page), or null. */
export async function guestByToken(token: string) {
  if (!token || token.length < 40 || token.length > 64) return null;
  const g = await db.chatGuest.findFirst({ where: { tokenHash: hash(token) } });
  if (!g || !g.tokenExp || g.tokenExp < new Date() || g.deactivatedAt || (g.expiresAt && g.expiresAt < new Date())) return null;
  const chs = await db.channel.findMany({ where: { id: { in: g.channelIds } }, select: { name: true } });
  return { g, channels: chs.map((c) => c.name), inviter: await wsName(g.ws, g.invitedBy) };
}

/** Trades a link for a guest session (making the account the first time). Returns the session id. */
export async function acceptGuest(token: string, b: { name?: unknown; tz?: unknown }) {
  const found = await guestByToken(token);
  if (!found) throw new HttpError(410, "This link has expired or was already used. Ask for a new one.");
  let g = found.g;
  const name = str(b.name, 80) || g.name || g.email.split("@")[0];
  const tz = typeof b.tz === "string" && isZone(b.tz) ? b.tz : undefined;
  if (!g.userId) {
    const userId = `guest_${crypto.randomBytes(9).toString("base64url")}`;
    await db.user.create({ data: { id: userId, email: g.email, name, ...(tz ? { tz } : {}) } });
    g = await db.chatGuest.update({ where: { id: g.id }, data: { userId, name, acceptedAt: new Date() } });
  } else await db.user.update({ where: { id: g.userId }, data: { name, ...(tz ? { tz } : {}) } });
  await db.member.upsert({ where: { ws_userId: { ws: g.ws, userId: g.userId! } }, create: { ws: g.ws, userId: g.userId! }, update: { seenAt: new Date() } });
  // One use: the link stops working now.
  g = await db.chatGuest.update({ where: { id: g.id }, data: { tokenHash: null, tokenExp: null, name } });
  await syncChannels(g);
  const id = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await db.session.create({ data: { id, userId: g.userId!, ws: g.ws, pass: "", passExp: now, perms: GUEST_PERMS, permsAt: now, guest: true, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) } });
  return { sid: id, maxAge: SESSION_DAYS * 86400 };
}

/** "Send me a new link": every active invitation for the address gets one (at most once a minute). Always "ok". */
export async function requestLink(raw: unknown) {
  const to = email(raw);
  if (!to) bad("Type your email address.");
  const rows = await db.chatGuest.findMany({ where: { email: to, deactivatedAt: null, acceptedAt: { not: null } } });
  for (const g of rows) {
    if (g.expiresAt && g.expiresAt < new Date()) continue;
    if (g.tokenExp && g.tokenExp.getTime() - LINK_DAYS * 86400_000 > Date.now() - 60_000) continue;
    const link = await newLink(g);
    await sendMail({ to, subject: "Your link to IOTx Chat", text: `Sign in to Chat as a guest:\n\n${link}\n\nIt works once and for ${LINK_DAYS} days. If you didn't ask for this, ignore this email.`, fromName: "IOTx Chat" });
  }
  return { ok: true };
}
