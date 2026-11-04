import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Prisma, type Channel, type ChatFile, type Message, type Reaction } from "@prisma/client";
import { db } from "./db";
import { can, HttpError, type Me } from "./auth";
import type { BusEvent } from "./bus";
import { publish } from "./bus";
import { notify } from "./notify";
import { bad } from "./http";
import { inDnd, isOnline, prefsOf } from "./presence";
import { unfurl } from "./unfurl";

/**
 * Team chat: public and private channels, direct and group messages, threads,
 * @mentions (people, @channel / @here, user groups), reactions, files and
 * voice messages, link previews, edits, pins, saved items with reminders,
 * scheduled messages, sharing, unread counts, search with filters, incoming
 * webhooks and admin tools. Delivery is Server-Sent Events from /api/stream
 * (topic "ws:<workspaceId>"), filtered per person by canSeeChannelEvent.
 */

export const isAdmin = (me: Me) => can(me, "teamchat.admin");
/** Guests ("guest_…") see only the channels they were added to; bots are "bot_…", workflows post as "wf_…". */
export const isGuest = (me: Pick<Me, "userId"> & { guest?: boolean }) => !!me.guest || me.userId.startsWith("guest_");
export const isAppId = (id: string) => id.startsWith("bot_") || id.startsWith("wf_");

/** Whether a chat bus event may go to this person (public channels, or channels they belong to). */
export async function canSeeChannelEvent(me: Me, ev: BusEvent) {
  const channelId = ev.channelId as string | undefined;
  if (!channelId) return true;
  if (ev.kind === "public" && !isGuest(me)) return true;
  const m = await db.channelMember.findUnique({ where: { channelId_userId: { channelId, userId: me.userId } } });
  return !!m;
}

/** Channels this person can read. */
const seeable = (me: Me): Prisma.ChannelWhereInput =>
  isGuest(me) ? { ws: me.ws, members: { some: { userId: me.userId } } } : { ws: me.ws, OR: [{ kind: "public" }, { members: { some: { userId: me.userId } } }] };

export async function loadChannel(me: Me, id: string, opts: { write?: boolean } = {}) {
  const ch = await db.channel.findUnique({ where: { id } });
  if (!ch || ch.ws !== me.ws) throw new HttpError(404, "Channel not found");
  const member = await db.channelMember.findUnique({ where: { channelId_userId: { channelId: id, userId: me.userId } } });
  if ((ch.kind !== "public" || isGuest(me)) && !member) throw new HttpError(404, "Channel not found");
  if (opts.write) {
    if (ch.archivedAt) bad("This channel is archived. Unarchive it to post.");
    // Posting in a public channel joins it.
    if (!member) await db.channelMember.create({ data: { channelId: id, userId: me.userId } });
  }
  return { ch, member };
}

/** Every workspace has #general, and everyone is in it. */
export async function ensureGeneral(me: Me) {
  let g = await db.channel.findFirst({ where: { ws: me.ws, kind: "public", name: "general" } });
  if (!g) g = await db.channel.create({ data: { ws: me.ws, kind: "public", name: "general", topic: "Everyone in the workspace", createdBy: me.userId } });
  await db.channelMember.upsert({ where: { channelId_userId: { channelId: g.id, userId: me.userId } }, create: { channelId: g.id, userId: me.userId }, update: {} });
}

/** Messages that show in the channel itself (thread replies only when also sent to the channel). */
const inChannel = (channelId: string): Prisma.MessageWhereInput => ({ channelId, OR: [{ parentId: null }, { alsoChannel: true }] });

export async function listChannels(me: Me) {
  if (!isGuest(me) && !isAppId(me.userId)) await ensureGeneral(me);
  const chs = await db.channel.findMany({
    where: { ...seeable(me), archivedAt: null },
    include: { members: { select: { userId: true, lastReadAt: true, muted: true, notifyLevel: true, starred: true } } },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  const out = [];
  for (const c of chs) {
    // Public channels I haven't joined come back with joined: false (the sidebar leaves them to the browser).
    const mine = c.members.find((m) => m.userId === me.userId);
    const since = mine && { createdAt: { gt: mine.lastReadAt }, userId: { not: me.userId }, deletedAt: null, system: false };
    const unread = since ? await db.message.count({ where: { ...inChannel(c.id), ...since } }) : 0;
    const mentions = since ? await db.message.count({ where: { channelId: c.id, ...since, mentions: { has: me.userId } } }) : 0;
    out.push({
      id: c.id, kind: c.kind, name: c.name, topic: c.topic, description: c.description, createdBy: c.createdBy, lastAt: c.lastAt,
      joined: !!mine, memberIds: c.members.map((m) => m.userId), unread, mentions, lastReadAt: mine?.lastReadAt ?? null,
      muted: !!mine?.muted, notifyLevel: mine?.notifyLevel ?? "all", starred: !!mine?.starred, retentionDays: c.retentionDays,
      dmWith: c.kind === "dm" ? c.members.map((m) => m.userId).find((u) => u !== me.userId) ?? me.userId : null,
      dmWithAll: c.kind === "dm" ? c.members.map((m) => m.userId).filter((u) => u !== me.userId) : [],
    });
  }
  return out.sort((a, b) => Number(b.name === "general" && b.kind === "public") - Number(a.name === "general" && a.kind === "public"));
}

/** Channel browser: every public channel (and private ones I'm in), joined or not, archived on request. */
export async function browseChannels(me: Me, q: { q?: string; archived?: boolean }) {
  const term = (q.q ?? "").trim().toLowerCase().slice(0, 60);
  const chs = await db.channel.findMany({
    where: { ...seeable(me), kind: { not: "dm" }, ...(q.archived ? { archivedAt: { not: null } } : { archivedAt: null }), ...(term ? { OR: [{ name: { contains: term } }, { topic: { contains: term, mode: "insensitive" } }] } : {}) },
    include: { members: { select: { userId: true } } },
    orderBy: { name: "asc" },
    take: 200,
  });
  return chs.map((c) => ({ id: c.id, kind: c.kind, name: c.name, topic: c.topic, description: c.description, members: c.members.length, joined: c.members.some((m) => m.userId === me.userId), archived: !!c.archivedAt, createdAt: c.createdAt }));
}

export async function unreadTotals(me: Me) {
  const ms = await db.channelMember.findMany({ where: { userId: me.userId, channel: { ws: me.ws, archivedAt: null } } });
  let total = 0;
  const channels: Record<string, number> = {};
  for (const m of ms) {
    const since = { createdAt: { gt: m.lastReadAt }, userId: { not: me.userId }, deletedAt: null, system: false };
    // Muted channels only count when I'm mentioned.
    const n = m.muted
      ? await db.message.count({ where: { channelId: m.channelId, ...since, mentions: { has: me.userId } } })
      : await db.message.count({ where: { ...inChannel(m.channelId), ...since } });
    if (n) channels[m.channelId] = n;
    total += n;
  }
  return { total, channels };
}

// ── Messages ───────────────────────────────────────────────────────────────

export const INCLUDE = { reactions: true, files: { omit: { path: true } } } as const;
type Row = Message & { reactions: Reaction[]; files: Omit<ChatFile, "path">[] };

export type MessageDto = ReturnType<typeof messageDto>;
export function messageDto(m: Row, extra: { shared?: Record<string, unknown> | null; hookName?: string } = {}) {
  const app = !!m.hookId || isAppId(m.userId);
  const agg = new Map<string, string[]>();
  for (const r of m.reactions) agg.set(r.emoji, [...(agg.get(r.emoji) ?? []), r.userId]);
  const gone = !!m.deletedAt;
  return {
    id: m.id, channelId: m.channelId, userId: m.userId, parentId: m.parentId,
    body: gone ? "" : m.body, deleted: gone, editedAt: m.editedAt, createdAt: m.createdAt,
    mentions: m.mentions, pinned: m.pinned, replyCount: m.replyCount, lastReplyAt: m.lastReplyAt, taskId: m.taskId,
    alsoChannel: m.alsoChannel, broadcast: m.broadcast, system: m.system,
    files: gone ? [] : (m.files ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size })),
    preview: gone ? null : (m.preview as { url: string; title: string; description: string; image: string; site: string } | null),
    shared: gone ? null : extra.shared ?? null, sharedId: m.sharedId,
    hookId: m.hookId, hookName: extra.hookName ?? null, app,
    reactions: [...agg.entries()].map(([emoji, users]) => ({ emoji, users })),
  };
}

/** DTOs with shared messages (only when I can see their channel) and webhook names filled in. */
async function hydrate(me: Me, rows: Row[]) {
  const sharedIds = [...new Set(rows.map((r) => r.sharedId).filter(Boolean))] as string[];
  const shared = sharedIds.length
    ? await db.message.findMany({ where: { id: { in: sharedIds }, deletedAt: null, channel: seeable(me) }, include: { ...INCLUDE, channel: { select: { name: true, kind: true } } } })
    : [];
  const hookIds = [...new Set(rows.map((r) => r.hookId).filter(Boolean))] as string[];
  const hooks = hookIds.length ? await db.chatHook.findMany({ where: { id: { in: hookIds } }, select: { id: true, name: true } }) : [];
  const wfIds = [...new Set(rows.map((r) => r.userId).filter((u) => u.startsWith("wf_")).map((u) => u.slice(3)))];
  const wfs = wfIds.length ? await db.chatWorkflow.findMany({ where: { id: { in: wfIds } }, select: { id: true, name: true } }) : [];
  return rows.map((r) => {
    const s = shared.find((x) => x.id === r.sharedId);
    return messageDto(r, {
      shared: s ? { ...messageDto(s), channelName: s.channel.name, channelKind: s.channel.kind } : null,
      hookName: hooks.find((h) => h.id === r.hookId)?.name ?? (r.userId.startsWith("wf_") ? wfs.find((w) => `wf_${w.id}` === r.userId)?.name ?? "Workflow" : undefined),
    });
  });
}
async function one(me: Me, id: string) {
  const r = await db.message.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  return (await hydrate(me, [r]))[0];
}

export async function listMessages(me: Me, channelId: string, q: { thread?: string; before?: string; after?: string; around?: string; limit?: number }) {
  await loadChannel(me, channelId);
  const take = Math.min(200, Math.max(1, q.limit ?? 50));
  if (q.thread) {
    const root = await db.message.findUnique({ where: { id: q.thread }, include: INCLUDE });
    if (!root || root.channelId !== channelId) throw new HttpError(404, "Not found");
    const replies = await db.message.findMany({ where: { parentId: root.id }, orderBy: { createdAt: "asc" }, include: INCLUDE, take: 1000 });
    const [r, ...rest] = await hydrate(me, [root, ...replies]);
    return { root: r, messages: rest };
  }
  if (q.around) {
    // A deep link to an older message: some before it, it, and some after.
    const at = await db.message.findUnique({ where: { id: q.around } });
    if (!at || at.channelId !== channelId) throw new HttpError(404, "Not found");
    const pivot = at.parentId && !at.alsoChannel ? (await db.message.findUnique({ where: { id: at.parentId } }))! : at;
    const older = await db.message.findMany({ where: { ...inChannel(channelId), createdAt: { lt: pivot.createdAt } }, orderBy: { createdAt: "desc" }, include: INCLUDE, take: 25 });
    const newer = await db.message.findMany({ where: { ...inChannel(channelId), createdAt: { gte: pivot.createdAt } }, orderBy: { createdAt: "asc" }, include: INCLUDE, take: 26 });
    return { messages: await hydrate(me, [...older.reverse(), ...newer]), more: older.length === 25, newer: newer.length === 26 };
  }
  if (q.after) {
    const rows = await db.message.findMany({ where: { ...inChannel(channelId), createdAt: { gt: new Date(q.after) } }, orderBy: { createdAt: "asc" }, include: INCLUDE, take });
    return { messages: await hydrate(me, rows), newer: rows.length === take };
  }
  const rows = await db.message.findMany({
    where: { ...inChannel(channelId), ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) },
    orderBy: { createdAt: "desc" },
    include: INCLUDE,
    take,
  });
  return { messages: await hydrate(me, rows.reverse()), more: rows.length === take };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const said = (text: string, handle: string) => new RegExp(`(^|[^\\w@])@${esc(handle)}(?![\\w-]|\\.\\w)`, "i").test(text);

/** People mentioned as @Name / @email-name / @group, plus @channel, @here and @everyone. */
async function resolveMentions(me: Me, ch: Channel, text: string, picked: string[] = []) {
  const ms = await db.member.findMany({ where: { ws: me.ws } });
  const users = await db.user.findMany({ where: { id: { in: ms.map((m) => m.userId) } } });
  const ids = new Set<string>();
  for (const u of users) {
    const handles = [u.name, u.email.split("@")[0], u.email].filter(Boolean) as string[];
    if (picked.includes(u.id) || handles.some((h) => said(text, h))) ids.add(u.id);
  }
  const groups = await db.userGroup.findMany({ where: { ws: me.ws } });
  for (const g of groups) if (said(text, g.handle)) for (const id of g.memberIds) ids.add(id);
  const members = await db.channelMember.findMany({ where: { channelId: ch.id } });
  const b = /(^|[^\w@])@(channel|everyone|here)\b/i.exec(text)?.[2]?.toLowerCase() ?? null;
  const broadcast = b === "everyone" ? "channel" : b;
  if (broadcast === "channel") for (const m of members) ids.add(m.userId);
  if (broadcast === "here") for (const m of members) if (isOnline(me.ws, m.userId)) ids.add(m.userId);
  for (const id of [...ids]) if ((ch.kind !== "public" || id.startsWith("guest_")) && !members.some((m) => m.userId === id)) ids.delete(id);
  ids.delete(me.userId);
  return { mentions: [...ids], broadcast };
}

const firstUrl = (text: string) => /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/i.exec(text)?.[0] ?? null;

/** Fills in a link preview after the message is out (it never delays sending). */
async function addPreview(ws: string, id: string, text: string, kind: string) {
  const url = firstUrl(text);
  if (!url) return;
  const p = await unfurl(url).catch(() => null);
  if (!p) return;
  const m = await db.message.update({ where: { id }, data: { preview: p }, include: INCLUDE });
  publish(`ws:${ws}`, { type: "message.update", channelId: m.channelId, kind, message: messageDto(m) });
}

type PostInput = { body?: string; parentId?: string; mentions?: string[]; fileIds?: string[]; alsoChannel?: boolean; sharedId?: string };

export async function postMessage(me: Me, channelId: string, input: PostInput, opts: { hookId?: string; at?: Date; asApp?: boolean } = {}) {
  // Workflows (asApp, me.userId "wf_…") post without being channel members; their owner's access is checked when they are saved.
  const app = !!opts.hookId || !!opts.asApp;
  const { ch } = opts.asApp ? { ch: await appChannel(me.ws, channelId) } : await loadChannel(me, channelId, { write: !opts.hookId });
  if (app && ch.archivedAt) bad("This channel is archived.");
  const text = String(input.body ?? "").trim().slice(0, 12000);
  const fileIds = [...new Set((input.fileIds ?? []).map(String))].slice(0, 10);
  const files = fileIds.length ? await db.chatFile.findMany({ where: { id: { in: fileIds }, userId: me.userId, channelId: ch.id, messageId: null } }) : [];
  if (files.length !== fileIds.length) bad("A file couldn't be attached. Upload it again.");
  let sharedId: string | null = null;
  if (input.sharedId) {
    const s = await db.message.findFirst({ where: { id: String(input.sharedId), deletedAt: null, channel: seeable(me) } });
    if (!s) bad("That message can't be shared.");
    sharedId = s.sharedId && !s.body ? s.sharedId : s.id;
  }
  if (!text && !files.length && !sharedId) bad("Write a message first.");
  let parent: Message | null = null;
  if (input.parentId) {
    parent = await db.message.findUnique({ where: { id: input.parentId } });
    if (!parent || parent.channelId !== ch.id || parent.parentId) bad("You can only reply to a message in this channel.");
  }
  const { mentions, broadcast } = opts.hookId ? { mentions: [], broadcast: null } : await resolveMentions(me, ch, text, input.mentions);
  const now = opts.at ?? new Date();
  const created = await db.message.create({
    data: { ws: me.ws, channelId: ch.id, userId: me.userId, parentId: parent?.id ?? null, body: text, mentions, broadcast, createdAt: now, alsoChannel: !!(parent && input.alsoChannel), sharedId, hookId: opts.hookId ?? null },
  });
  if (files.length) await db.chatFile.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { messageId: created.id } });
  await db.channel.update({ where: { id: ch.id }, data: { lastAt: now } });
  if (!app) await db.channelMember.update({ where: { channelId_userId: { channelId: ch.id, userId: me.userId } }, data: { lastReadAt: now } });
  if (parent) {
    const p = await db.message.update({ where: { id: parent.id }, data: { replyCount: { increment: 1 }, lastReplyAt: now }, include: INCLUDE });
    publish(`ws:${me.ws}`, { type: "message.update", channelId: ch.id, kind: ch.kind, message: (await hydrate(me, [p]))[0] });
  }
  const dto = await one(me, created.id);
  publish(`ws:${me.ws}`, { type: "message", channelId: ch.id, kind: ch.kind, message: dto });
  void addPreview(me.ws, created.id, text, ch.kind).catch(() => {});
  // Bots hear people (not other apps); keyword workflows run on people's messages.
  if (!app && !isAppId(me.userId)) void import("./chat-apps").then((a) => a.afterMessage(me, ch, created)).catch((e) => console.error("chat apps", e));

  // Notifications (the bell): mentions, DMs, and replies to threads I'm in. "Nothing" channels stay quiet.
  const quiet = new Set((await db.channelMember.findMany({ where: { channelId: ch.id, notifyLevel: "none" } })).map((m) => m.userId));
  const where = ch.kind === "dm" ? "a direct message" : `#${ch.name}`;
  const link = `/chat?channel=${ch.id}${parent ? `&thread=${parent.id}` : ""}&message=${created.id}`;
  const snippet = text.slice(0, 200) || (files.length ? `Shared ${files.length === 1 ? files[0].name : `${files.length} files`}` : "Shared a message");
  const who = opts.hookId ? (await db.chatHook.findUnique({ where: { id: opts.hookId } }))?.name ?? "A webhook" : me.name;
  const told = new Set<string>();
  for (const uid of mentions) {
    if (quiet.has(uid)) continue;
    told.add(uid);
    await notify({ ws: me.ws, userId: uid, kind: "mention", title: broadcast ? `${who} notified @${broadcast} in ${where}` : `${who} mentioned you in ${where}`, body: snippet, link });
  }
  if (ch.kind === "dm") {
    const others = await db.channelMember.findMany({ where: { channelId: ch.id, userId: { not: me.userId } } });
    for (const o of others) if (!told.has(o.userId) && !quiet.has(o.userId)) {
      told.add(o.userId);
      await notify({ ws: me.ws, userId: o.userId, kind: "dm", title: `${who} sent you a message`, body: snippet, link });
    }
  }
  if (parent) {
    // Everyone in the thread (the author and past repliers) follows it.
    const repliers = await db.message.findMany({ where: { parentId: parent.id, deletedAt: null }, select: { userId: true }, distinct: ["userId"] });
    const followers = new Set([parent.userId, ...repliers.map((r) => r.userId)]);
    for (const uid of followers) if (uid !== me.userId && !told.has(uid) && !quiet.has(uid))
      await notify({ ws: me.ws, userId: uid, kind: "reply", title: `${who} replied to a thread in ${where}`, body: snippet, link });
  }
  return dto;
}

/** Sends a message to everyone who can see it again (after an app changed it). */
export async function republish(ws: string, id: string, type = "message.update") {
  const r = await db.message.findUnique({ where: { id }, include: { ...INCLUDE, channel: { select: { kind: true } } } });
  if (r) publish(`ws:${ws}`, { type, channelId: r.channelId, kind: r.channel.kind, message: messageDto(r) });
}

async function appChannel(ws: string, id: string) {
  const ch = await db.channel.findUnique({ where: { id } });
  if (!ch || ch.ws !== ws) throw new HttpError(404, "Channel not found");
  return ch;
}

export async function loadMessage(me: Me, id: string) {
  const m = await db.message.findUnique({ where: { id }, include: INCLUDE });
  if (!m || m.ws !== me.ws) throw new HttpError(404, "Message not found");
  const { ch, member } = await loadChannel(me, m.channelId);
  return { m, ch, member };
}
export async function getMessage(me: Me, id: string) {
  const { m } = await loadMessage(me, id);
  return (await hydrate(me, [m]))[0];
}

export async function editMessage(me: Me, id: string, input: { body?: string; pinned?: boolean }) {
  const { m, ch, member } = await loadMessage(me, id);
  if (ch.archivedAt) bad("This channel is archived.");
  const data: Prisma.MessageUpdateInput = {};
  let text = "";
  if (input.body !== undefined) {
    if (m.userId !== me.userId || m.hookId) throw new HttpError(403, "You can only edit your own messages.");
    if (m.deletedAt) bad("That message was deleted.");
    text = String(input.body).trim().slice(0, 12000);
    if (!text && !m.files.length && !m.sharedId) bad("A message can't be empty. Delete it instead.");
    const r = await resolveMentions(me, ch, text);
    Object.assign(data, { body: text, editedAt: new Date(), mentions: r.mentions, broadcast: r.broadcast });
    if (firstUrl(text) !== (m.preview as { url?: string } | null)?.url) data.preview = Prisma.DbNull;
  }
  if (typeof input.pinned === "boolean") {
    if (!member && !isAdmin(me)) throw new HttpError(403, "Join the channel to pin messages.");
    data.pinned = input.pinned;
  }
  await db.message.update({ where: { id }, data });
  const dto = await one(me, id);
  publish(`ws:${me.ws}`, { type: "message.update", channelId: ch.id, kind: ch.kind, message: dto });
  if (text && firstUrl(text) !== (m.preview as { url?: string } | null)?.url) void addPreview(me.ws, id, text, ch.kind).catch(() => {});
  return dto;
}

const FILES = path.join(process.cwd(), "storage", "chat-files");

export async function deleteMessage(me: Me, id: string) {
  const { m, ch } = await loadMessage(me, id);
  if (m.userId !== me.userId && !isAdmin(me)) throw new HttpError(403, "You can only delete your own messages.");
  const files = await db.chatFile.findMany({ where: { messageId: id } });
  await db.chatFile.deleteMany({ where: { messageId: id } });
  for (const f of files) await fs.rm(path.join(FILES, f.path), { force: true });
  const u = await db.message.update({ where: { id }, data: { deletedAt: new Date(), body: "", pinned: false, mentions: [], preview: Prisma.DbNull, sharedId: null }, include: INCLUDE });
  publish(`ws:${me.ws}`, { type: "message.delete", channelId: ch.id, kind: ch.kind, message: messageDto(u) });
  return { ok: true };
}

export async function toggleReaction(me: Me, id: string, emoji: string) {
  const e = String(emoji ?? "").trim();
  if (!e || e.length > 32) bad("Pick an emoji.");
  const { m, ch } = await loadMessage(me, id);
  if (m.deletedAt) bad("That message was deleted.");
  if (ch.archivedAt) bad("This channel is archived.");
  const key = { messageId_userId_emoji: { messageId: id, userId: me.userId, emoji: e } };
  const had = await db.reaction.findUnique({ where: key });
  if (had) await db.reaction.delete({ where: key });
  else {
    if ((await db.reaction.groupBy({ by: ["emoji"], where: { messageId: id } })).length >= 50) bad("A message can have up to 50 different reactions.");
    await db.reaction.create({ data: { messageId: id, userId: me.userId, emoji: e } });
    if (!isAppId(me.userId)) void import("./chat-apps").then((a) => a.onReaction(me, ch, m, e)).catch((err) => console.error("chat apps", err));
  }
  const dto = await one(me, id);
  publish(`ws:${me.ws}`, { type: "reaction", channelId: ch.id, kind: ch.kind, message: dto });
  return dto;
}

/** Mark read up to now, or (for "mark unread") up to just before a message. */
export async function markRead(me: Me, channelId: string, unreadFrom?: string) {
  const { ch, member } = await loadChannel(me, channelId);
  if (!member) return { ok: true };
  let at = new Date();
  if (unreadFrom) {
    const m = await db.message.findUnique({ where: { id: unreadFrom } });
    if (!m || m.channelId !== ch.id) bad("That message isn't in this channel.");
    at = new Date(m.createdAt.getTime() - 1);
  }
  await db.channelMember.update({ where: { channelId_userId: { channelId: ch.id, userId: me.userId } }, data: { lastReadAt: at } });
  publish(`user:${me.userId}`, { type: "read", channelId: ch.id, unread: !!unreadFrom });
  return { ok: true, lastReadAt: at };
}

export async function typing(me: Me, channelId: string, parentId?: string) {
  const { ch } = await loadChannel(me, channelId);
  publish(`ws:${me.ws}`, { type: "typing", channelId: ch.id, kind: ch.kind, userId: me.userId, name: me.name, parentId: parentId ?? null });
  return { ok: true };
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * Slack-style filters: from:@name (or from:me), in:#channel / in:@name,
 * before: / after: / on: YYYY-MM-DD, has:file / has:image / has:link /
 * has:pin / has:reaction, is:thread / is:saved. The rest is matched as text.
 */
export async function search(me: Me, q: string) {
  const raw = q.trim().slice(0, 300);
  const where: Prisma.MessageWhereInput[] = [{ ws: me.ws, deletedAt: null, channel: seeable(me) }];
  const words: string[] = [];
  const ms = await db.member.findMany({ where: { ws: me.ws } });
  const users = await db.user.findMany({ where: { id: { in: ms.map((m) => m.userId) } } });
  const person = (v: string) => {
    const t = v.replace(/^@/, "").toLowerCase();
    if (t === "me") return me.userId;
    return users.find((u) => [u.name ?? "", u.email, u.email.split("@")[0]].some((h) => h.toLowerCase() === t || h.toLowerCase().replace(/\s+/g, "") === t))?.id ?? "-";
  };
  const day = (v: string) => {
    const d = new Date(`${v}T00:00:00`);
    if (isNaN(d.getTime())) bad(`"${v}" isn't a date. Use YYYY-MM-DD.`);
    return d;
  };
  let filters = 0;
  for (const tok of raw.match(/(\w+:"[^"]*"|\S+)/g) ?? []) {
    const f = /^(from|in|before|after|on|during|has|is):(.+)$/i.exec(tok);
    if (!f) {
      words.push(tok.replace(/^"|"$/g, ""));
      continue;
    }
    filters++;
    const [, k, v0] = f;
    const v = v0.replace(/^"|"$/g, "");
    switch (k.toLowerCase()) {
      case "from": where.push({ userId: person(v) }); break;
      case "in":
        if (v.startsWith("@")) {
          const uid = person(v);
          where.push({ channel: { kind: "dm", AND: [{ members: { some: { userId: uid } } }, { members: { some: { userId: me.userId } } }] } });
        } else where.push({ channel: { name: v.replace(/^#/, "").toLowerCase() } });
        break;
      case "before": where.push({ createdAt: { lt: day(v) } }); break;
      case "after": where.push({ createdAt: { gte: new Date(day(v).getTime() + 86400_000) } }); break;
      case "on": case "during": {
        const d = day(v.length === 7 ? `${v}-01` : v);
        const end = v.length === 7 ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : new Date(d.getTime() + 86400_000);
        where.push({ createdAt: { gte: d, lt: end } });
        break;
      }
      case "has":
        if (v === "file") where.push({ files: { some: {} } });
        else if (v === "image") where.push({ files: { some: { type: { startsWith: "image/" } } } });
        else if (v === "link") where.push({ body: { contains: "http" } });
        else if (v === "pin") where.push({ pinned: true });
        else if (v === "reaction") where.push({ reactions: { some: {} } });
        break;
      case "is":
        if (v === "thread") where.push({ OR: [{ parentId: { not: null } }, { replyCount: { gt: 0 } }] });
        else if (v === "saved") {
          const saved = await db.savedMessage.findMany({ where: { userId: me.userId }, select: { messageId: true } });
          where.push({ id: { in: saved.map((s) => s.messageId) } });
        }
        break;
    }
  }
  const text = words.join(" ").trim();
  if (!filters && text.length < 2) return [];
  if (text) where.push({ OR: [{ body: { contains: text, mode: "insensitive" } }, { files: { some: { name: { contains: text, mode: "insensitive" } } } }] });
  const rows = await db.message.findMany({
    where: { AND: where },
    orderBy: { createdAt: "desc" },
    include: { ...INCLUDE, channel: { select: { name: true, kind: true } } },
    take: 50,
  });
  const dtos = await hydrate(me, rows);
  return dtos.map((d, i) => ({ ...d, channelName: rows[i].channel.name, channelKind: rows[i].channel.kind }));
}

// ── Direct and group messages ──────────────────────────────────────────────

export async function openDm(me: Me, userIds: string[]) {
  const ids = [...new Set([me.userId, ...userIds.map(String)])];
  if (ids.length > 9) bad("A group message can have up to 9 people.");
  const known = await db.member.findMany({ where: { ws: me.ws, userId: { in: ids } } });
  if (known.length !== ids.length) throw new HttpError(404, "That person isn't in this workspace.");
  if (isGuest(me)) {
    const mine = (await db.channelMember.findMany({ where: { userId: me.userId, channel: { kind: { not: "dm" } } }, select: { channelId: true } })).map((c) => c.channelId);
    for (const u of ids) if (u !== me.userId && !(await db.channelMember.findFirst({ where: { userId: u, channelId: { in: mine } } })))
      throw new HttpError(403, "As a guest you can message people in your channels only.");
  }
  const dmKey = [...ids].sort().join(":");
  const existing = await db.channel.findUnique({ where: { ws_dmKey: { ws: me.ws, dmKey } } });
  if (existing) return existing;
  const ch = await db.channel.create({ data: { ws: me.ws, kind: "dm", name: "dm", dmKey, createdBy: me.userId, members: { create: ids.map((u) => ({ userId: u })) } } });
  publish(`ws:${me.ws}`, { type: "channel", channelId: ch.id, kind: ch.kind });
  return ch;
}

// ── Channel settings and membership ────────────────────────────────────────

export const channelName = (s: unknown) => String(s ?? "").slice(0, 80).toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

async function systemNote(me: Me, ch: Channel, text: string) {
  // A small "joined" / "renamed" line, posted as the person who did it.
  const m = await db.message.create({ data: { ws: me.ws, channelId: ch.id, userId: me.userId, body: text, system: true } });
  publish(`ws:${me.ws}`, { type: "message", channelId: ch.id, kind: ch.kind, message: await one(me, m.id) });
}

export async function updateChannel(me: Me, id: string, b: { name?: string; topic?: string; description?: string; archived?: boolean; retentionDays?: number | null }) {
  const { ch, member } = await loadChannel(me, id);
  if (ch.kind === "dm") bad("Direct messages can't be changed.");
  const owner = ch.createdBy === me.userId || isAdmin(me);
  if (!member && !isAdmin(me)) throw new HttpError(403, "Join the channel first.");
  const data: Prisma.ChannelUpdateInput = {};
  const notes: string[] = [];
  if (b.topic !== undefined) { data.topic = String(b.topic ?? "").slice(0, 300); notes.push(`set the topic: ${data.topic || "(none)"}`); }
  if (b.description !== undefined) data.description = String(b.description ?? "").slice(0, 1000);
  if (b.name !== undefined) {
    if (ch.name === "general" && ch.kind === "public") bad("#general can't be renamed.");
    if (!owner) throw new HttpError(403, "Only the channel's creator or an admin can rename it.");
    const name = channelName(b.name);
    if (!name) bad("Give the channel a name.");
    if (name !== ch.name && (await db.channel.findFirst({ where: { ws: me.ws, name, kind: { not: "dm" } } }))) throw new HttpError(409, `#${name} already exists.`);
    if (name !== ch.name) notes.push(`renamed the channel from #${ch.name} to #${name}`);
    data.name = name;
  }
  if (b.archived !== undefined) {
    if (ch.name === "general" && ch.kind === "public") bad("#general can't be archived.");
    if (!owner) throw new HttpError(403, "Only the channel's creator or an admin can archive it.");
    if (b.archived && !ch.archivedAt) notes.push("archived the channel");
    if (!b.archived && ch.archivedAt) notes.push("unarchived the channel");
    data.archivedAt = b.archived ? new Date() : null;
  }
  if (b.retentionDays !== undefined) {
    if (!isAdmin(me)) throw new HttpError(403, "Only admins can set message retention.");
    const d = b.retentionDays === null ? null : Math.round(Number(b.retentionDays));
    if (d !== null && (!(d >= 1) || d > 3650)) bad("Keep messages for 1 to 3650 days, or forever.");
    data.retentionDays = d;
  }
  // Archive notes go in before the channel turns read-only; unarchive notes after.
  const before = notes.filter((n) => n !== "unarchived the channel");
  for (const n of before) await systemNote(me, ch, n);
  const u = await db.channel.update({ where: { id }, data });
  if (notes.includes("unarchived the channel")) await systemNote(me, u, "unarchived the channel");
  publish(`ws:${me.ws}`, { type: "channel", channelId: id, kind: ch.kind });
  return u;
}

export async function joinChannel(me: Me, id: string) {
  const { ch, member } = await loadChannel(me, id);
  if (ch.kind !== "public") throw new HttpError(403, "Private channels are invite-only.");
  if (ch.archivedAt) bad("This channel is archived.");
  if (!member) {
    await db.channelMember.create({ data: { channelId: id, userId: me.userId } });
    await systemNote(me, ch, "joined the channel");
    void import("./chat-apps").then((a) => a.onJoined(me, ch, [me.userId])).catch((e) => console.error("chat apps", e));
    publish(`ws:${me.ws}`, { type: "channel", channelId: id, kind: ch.kind });
  }
  return { ok: true };
}

export async function leaveChannel(me: Me, id: string) {
  const { ch, member } = await loadChannel(me, id);
  if (ch.kind === "dm") bad("You can't leave a direct message.");
  if (ch.kind === "public" && ch.name === "general") bad("Everyone stays in #general.");
  if (member) {
    if (!ch.archivedAt) await systemNote(me, ch, "left the channel");
    await db.channelMember.deleteMany({ where: { channelId: id, userId: me.userId } });
    publish(`ws:${me.ws}`, { type: "channel", channelId: id, kind: ch.kind });
  }
  return { ok: true };
}

export async function addMembers(me: Me, id: string, userIds: string[]) {
  const { ch, member } = await loadChannel(me, id);
  if ((!member && !isAdmin(me)) || ch.kind === "dm" || isGuest(me)) throw new HttpError(403, "Only members can add people.");
  if (!isAdmin(me) && userIds.some((u) => String(u).startsWith("guest_"))) throw new HttpError(403, "Only admins can add guests to channels.");
  if (ch.archivedAt) bad("This channel is archived.");
  const known = await db.member.findMany({ where: { ws: me.ws, userId: { in: userIds.slice(0, 500) } } });
  let added = 0;
  for (const k of known) {
    const had = await db.channelMember.findUnique({ where: { channelId_userId: { channelId: id, userId: k.userId } } });
    if (had) continue;
    await db.channelMember.create({ data: { channelId: id, userId: k.userId } });
    added++;
    await notify({ ws: me.ws, userId: k.userId, kind: "channel", title: `${me.name} added you to #${ch.name}`, link: `/chat?channel=${id}` });
  }
  if (added) {
    const us = await db.user.findMany({ where: { id: { in: known.map((k) => k.userId) } } });
    await systemNote(me, ch, `added ${us.map((u) => u.name || u.email).join(", ")}`);
    void import("./chat-apps").then((a) => a.onJoined(me, ch, known.map((k) => k.userId))).catch((e) => console.error("chat apps", e));
  }
  publish(`ws:${me.ws}`, { type: "channel", channelId: id, kind: ch.kind });
  return { ok: true, added };
}

export async function removeMember(me: Me, id: string, userId: string) {
  const { ch } = await loadChannel(me, id);
  if (ch.kind === "dm") bad("People can't be removed from a direct message.");
  if (ch.kind === "public" && ch.name === "general") bad("Everyone stays in #general.");
  if (userId === me.userId) return leaveChannel(me, id);
  if (!isAdmin(me) && !(ch.kind === "private" && ch.createdBy === me.userId)) throw new HttpError(403, "Only admins (or the creator of a private channel) can remove people.");
  const n = await db.channelMember.deleteMany({ where: { channelId: id, userId } });
  if (n.count) {
    const u = await db.user.findUnique({ where: { id: userId } });
    await systemNote(me, ch, `removed ${u?.name || u?.email || "someone"}`);
  }
  publish(`ws:${me.ws}`, { type: "channel", channelId: id, kind: ch.kind });
  return { ok: true };
}

export async function memberPrefs(me: Me, id: string, b: { muted?: boolean; notifyLevel?: string; starred?: boolean }) {
  const { member } = await loadChannel(me, id);
  if (!member) bad("Join the channel first.");
  const data: Prisma.ChannelMemberUpdateInput = {};
  if (typeof b.muted === "boolean") data.muted = b.muted;
  if (typeof b.starred === "boolean") data.starred = b.starred;
  if (b.notifyLevel !== undefined) {
    if (!["all", "mentions", "none"].includes(String(b.notifyLevel))) bad("Notify for all messages, mentions, or nothing.");
    data.notifyLevel = String(b.notifyLevel);
  }
  const u = await db.channelMember.update({ where: { channelId_userId: { channelId: id, userId: me.userId } }, data });
  publish(`user:${me.userId}`, { type: "channel", channelId: id });
  return { muted: u.muted, notifyLevel: u.notifyLevel, starred: u.starred };
}

/** Admin export: the whole channel as JSON (people as names and emails). */
export async function exportChannel(me: Me, id: string) {
  if (!isAdmin(me)) throw new HttpError(403, "Only admins can export channels.");
  const { ch } = await loadChannel(me, id).catch(async (e) => {
    // Admins can export private channels they aren't in.
    const c = await db.channel.findUnique({ where: { id } });
    if (!c || c.ws !== me.ws) throw e;
    return { ch: c };
  });
  const rows = await db.message.findMany({ where: { channelId: ch.id, deletedAt: null }, orderBy: { createdAt: "asc" }, include: INCLUDE, take: 100_000 });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } } });
  const who = (uid: string) => users.find((u) => u.id === uid);
  return {
    channel: { name: ch.name, kind: ch.kind, topic: ch.topic, description: ch.description, createdAt: ch.createdAt, archivedAt: ch.archivedAt },
    exportedAt: new Date(),
    messages: rows.map((r) => ({
      id: r.id, at: r.createdAt, user: who(r.userId)?.name ?? "", email: who(r.userId)?.email ?? "", text: r.body, thread: r.parentId,
      editedAt: r.editedAt, pinned: r.pinned, files: r.files.map((f) => f.name), reactions: r.reactions.map((x) => x.emoji),
    })),
  };
}

// ── Files ──────────────────────────────────────────────────────────────────

export async function uploadFile(me: Me, channelId: string, file: File) {
  const { ch } = await loadChannel(me, channelId, { write: true });
  if (!file.size) bad("Choose a file.");
  if (file.size > 25 * 1024 * 1024) bad("Files can be up to 25 MB.");
  const safe = (file.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const rel = path.join(ch.id, `${crypto.randomUUID()}-${safe}`);
  await fs.mkdir(path.join(FILES, ch.id), { recursive: true });
  await fs.writeFile(path.join(FILES, rel), Buffer.from(await file.arrayBuffer()));
  const { path: _p, ...row } = await db.chatFile.create({ data: { ws: me.ws, channelId: ch.id, userId: me.userId, name: safe, type: (file.type || "application/octet-stream").slice(0, 100), size: file.size, path: rel } });
  return row;
}

export async function readFile(me: Me, id: string) {
  const f = await db.chatFile.findUnique({ where: { id } });
  if (!f || f.ws !== me.ws) throw new HttpError(404, "File not found");
  await loadChannel(me, f.channelId);
  // Unsent uploads are only visible to the person who added them.
  if (!f.messageId && f.userId !== me.userId) throw new HttpError(404, "File not found");
  if (f.messageId) {
    const m = await db.message.findUnique({ where: { id: f.messageId } });
    if (!m || m.deletedAt) throw new HttpError(404, "File not found");
  }
  return { f, data: await fs.readFile(path.join(FILES, f.path)) };
}

export async function discardFile(me: Me, id: string) {
  const f = await db.chatFile.findUnique({ where: { id } });
  if (!f || f.ws !== me.ws || f.userId !== me.userId || f.messageId) throw new HttpError(404, "File not found");
  await db.chatFile.delete({ where: { id } });
  await fs.rm(path.join(FILES, f.path), { force: true });
  return { ok: true };
}

/** Files in channels I can see, newest first, optionally matching a name. */
export async function listFiles(me: Me, q: { q?: string; channelId?: string }) {
  const rows = await db.chatFile.findMany({
    where: {
      ws: me.ws, messageId: { not: null }, message: { deletedAt: null, channel: seeable(me) },
      ...(q.channelId ? { channelId: q.channelId } : {}),
      ...(q.q?.trim() ? { name: { contains: q.q.trim().slice(0, 100), mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    omit: { path: true },
    take: 100,
  });
  return rows;
}

// ── Saved items, reminders, scheduled messages ─────────────────────────────

export async function saveMessage(me: Me, messageId: string, b: { remindAt?: string | null; done?: boolean; saved?: boolean }) {
  await loadMessage(me, messageId);
  const key = { userId_messageId: { userId: me.userId, messageId } };
  if (b.saved === false) {
    await db.savedMessage.deleteMany({ where: { userId: me.userId, messageId } });
    return { saved: false };
  }
  const remindAt = b.remindAt ? new Date(b.remindAt) : b.remindAt === null ? null : undefined;
  if (remindAt && isNaN(remindAt.getTime())) bad("Pick a valid reminder time.");
  const row = await db.savedMessage.upsert({
    where: key,
    create: { userId: me.userId, messageId, remindAt: remindAt ?? null, done: !!b.done },
    update: { ...(remindAt !== undefined ? { remindAt, reminded: false } : {}), ...(typeof b.done === "boolean" ? { done: b.done } : {}) },
  });
  return { saved: true, remindAt: row.remindAt, done: row.done };
}

export async function listSaved(me: Me) {
  const rows = await db.savedMessage.findMany({ where: { userId: me.userId }, orderBy: [{ done: "asc" }, { createdAt: "desc" }], take: 200 });
  const msgs = await db.message.findMany({ where: { id: { in: rows.map((r) => r.messageId) }, ws: me.ws, channel: seeable(me) }, include: { ...INCLUDE, channel: { select: { name: true, kind: true } } } });
  const dtos = await hydrate(me, msgs);
  return rows.flatMap((r) => {
    const i = msgs.findIndex((m) => m.id === r.messageId);
    return i < 0 ? [] : [{ remindAt: r.remindAt, done: r.done, savedAt: r.createdAt, message: { ...dtos[i], channelName: msgs[i].channel.name, channelKind: msgs[i].channel.kind } }];
  });
}

export async function scheduleMessage(me: Me, channelId: string, b: PostInput & { sendAt?: string }) {
  const { ch } = await loadChannel(me, channelId, { write: true });
  const at = new Date(String(b.sendAt ?? ""));
  if (isNaN(at.getTime()) || at.getTime() < Date.now() + 30_000) bad("Pick a time at least a minute from now.");
  if (at.getTime() > Date.now() + 120 * 86400_000) bad("Messages can be scheduled up to 120 days ahead.");
  const text = String(b.body ?? "").trim().slice(0, 12000);
  const fileIds = (b.fileIds ?? []).map(String).slice(0, 10);
  if (!text && !fileIds.length) bad("Write a message first.");
  if ((await db.scheduledMessage.count({ where: { userId: me.userId } })) >= 100) bad("You can have up to 100 scheduled messages.");
  if (b.parentId && !(await db.message.findFirst({ where: { id: b.parentId, channelId: ch.id, parentId: null } }))) bad("You can only reply to a message in this channel.");
  return db.scheduledMessage.create({ data: { ws: me.ws, channelId: ch.id, userId: me.userId, parentId: b.parentId ?? null, body: text, fileIds, sendAt: at } });
}

export async function listScheduled(me: Me) {
  const rows = await db.scheduledMessage.findMany({ where: { ws: me.ws, userId: me.userId }, orderBy: { sendAt: "asc" } });
  const chs = await db.channel.findMany({ where: { id: { in: rows.map((r) => r.channelId) } }, select: { id: true, name: true, kind: true } });
  return rows.map((r) => ({ ...r, channelName: chs.find((c) => c.id === r.channelId)?.name ?? "", channelKind: chs.find((c) => c.id === r.channelId)?.kind ?? "" }));
}

export async function updateScheduled(me: Me, id: string, b: { body?: string; sendAt?: string; sendNow?: boolean; cancel?: boolean }) {
  const s = await db.scheduledMessage.findUnique({ where: { id } });
  if (!s || s.userId !== me.userId || s.ws !== me.ws) throw new HttpError(404, "Scheduled message not found");
  if (b.cancel) {
    await db.scheduledMessage.delete({ where: { id } });
    return { ok: true };
  }
  if (b.sendNow) {
    await db.scheduledMessage.delete({ where: { id } });
    return { message: await postMessage(me, s.channelId, { body: s.body, parentId: s.parentId ?? undefined, fileIds: s.fileIds }) };
  }
  const data: Prisma.ScheduledMessageUpdateInput = {};
  if (b.body !== undefined) {
    data.body = String(b.body).trim().slice(0, 12000);
    if (!data.body && !s.fileIds.length) bad("Write a message first.");
  }
  if (b.sendAt !== undefined) {
    const at = new Date(b.sendAt);
    if (isNaN(at.getTime()) || at.getTime() < Date.now() + 30_000) bad("Pick a time at least a minute from now.");
    data.sendAt = at;
  }
  return db.scheduledMessage.update({ where: { id }, data });
}

/** Background jobs: scheduled sends, saved-item reminders, retention, unread-mention emails. */
export async function chatTick(now = new Date()) {
  let sent = 0, reminded = 0, emailed = 0, purged = 0;
  for (const s of await db.scheduledMessage.findMany({ where: { sendAt: { lte: now } }, take: 200 })) {
    await db.scheduledMessage.delete({ where: { id: s.id } }).catch(() => null);
    const u = await db.user.findUnique({ where: { id: s.userId } });
    const me = { userId: s.userId, ws: s.ws, name: u?.name || u?.email || "Someone", email: u?.email ?? "", perms: {} } as unknown as Me;
    try {
      await postMessage(me, s.channelId, { body: s.body, parentId: s.parentId ?? undefined, fileIds: s.fileIds });
      sent++;
    } catch (e) {
      await notify({ ws: s.ws, userId: s.userId, kind: "chat", title: "A scheduled message couldn't be sent", body: `${(e as Error).message} — "${s.body.slice(0, 120)}"`, link: `/chat?channel=${s.channelId}` });
    }
  }
  for (const r of await db.savedMessage.findMany({ where: { remindAt: { lte: now }, reminded: false, done: false }, take: 200 })) {
    await db.savedMessage.update({ where: { userId_messageId: { userId: r.userId, messageId: r.messageId } }, data: { reminded: true } });
    const m = await db.message.findUnique({ where: { id: r.messageId }, include: { channel: true } });
    if (!m || m.deletedAt) continue;
    await notify({ ws: m.ws, userId: r.userId, kind: "later", title: `Reminder: ${m.channel.kind === "dm" ? "a direct message" : `#${m.channel.name}`}`, body: m.body.slice(0, 200), link: `/chat?channel=${m.channelId}${m.parentId ? `&thread=${m.parentId}` : ""}&message=${m.id}` });
    reminded++;
  }
  for (const ch of await db.channel.findMany({ where: { retentionDays: { not: null } } })) {
    const cut = new Date(now.getTime() - ch.retentionDays! * 86400_000);
    const old = await db.chatFile.findMany({ where: { channelId: ch.id, message: { createdAt: { lt: cut } } } });
    for (const f of old) await fs.rm(path.join(FILES, f.path), { force: true });
    // Replies go with their thread (cascade on parent isn't modelled, so delete them first).
    const roots = await db.message.findMany({ where: { channelId: ch.id, createdAt: { lt: cut } }, select: { id: true } });
    const ids = roots.map((r) => r.id);
    if (ids.length) {
      await db.message.deleteMany({ where: { parentId: { in: ids } } });
      purged += (await db.message.deleteMany({ where: { id: { in: ids } } })).count;
    }
  }
  // Unsent uploads older than a day.
  for (const f of await db.chatFile.findMany({ where: { messageId: null, createdAt: { lt: new Date(now.getTime() - 86400_000) } }, take: 200 })) {
    await db.chatFile.delete({ where: { id: f.id } }).catch(() => null);
    await fs.rm(path.join(FILES, f.path), { force: true });
  }
  emailed = await mentionEmails(now);
  await (await import("./chat-apps")).workflowTick(now).catch((e) => console.error("workflow tick", e));
  return { sent, reminded, emailed, purged };
}

/**
 * Unread mentions and direct messages, emailed to people who are away (not
 * online, not in do-not-disturb, email on) after 5 minutes, once per batch.
 */
async function mentionEmails(now: Date) {
  const { sendMail } = await import("./cal-mail");
  const cutoff = new Date(now.getTime() - 5 * 60_000);
  let n = 0;
  const cands = await db.message.findMany({
    where: { createdAt: { gt: new Date(now.getTime() - 24 * 3600_000), lte: cutoff }, deletedAt: null, hookId: null, system: false, OR: [{ mentions: { isEmpty: false } }, { channel: { kind: "dm" } }] },
    include: { channel: { include: { members: true } } },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  const batches = new Map<string, { ws: string; userId: string; channelId: string; chName: string; kind: string; msgs: typeof cands }>();
  for (const m of cands) {
    const targets = m.channel.kind === "dm" ? m.channel.members.map((x) => x.userId).filter((u) => u !== m.userId) : m.mentions;
    for (const uid of targets) {
      const mem = m.channel.members.find((x) => x.userId === uid);
      if (!mem || mem.notifyLevel === "none" || m.createdAt <= mem.lastReadAt || (mem.emailedAt && m.createdAt <= mem.emailedAt)) continue;
      const k = `${m.channelId}:${uid}`;
      const b = batches.get(k) ?? { ws: m.ws, userId: uid, channelId: m.channelId, chName: m.channel.name, kind: m.channel.kind, msgs: [] };
      b.msgs.push(m);
      batches.set(k, b);
    }
  }
  for (const b of batches.values()) {
    const u = await db.user.findUnique({ where: { id: b.userId } });
    if (!u?.email) continue;
    const p = prefsOf(u.chatPrefs);
    if (p.email === false || inDnd(p, now) || isOnline(b.ws, b.userId)) continue;
    const senders = await db.user.findMany({ where: { id: { in: [...new Set(b.msgs.map((m) => m.userId))] } } });
    const who = (id: string) => senders.find((s) => s.id === id)?.name || "Someone";
    const where = b.kind === "dm" ? "a direct message" : `#${b.chName}`;
    const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    const link = `${base}/workspace/chat?channel=${b.channelId}&message=${b.msgs[b.msgs.length - 1].id}`;
    const lines = b.msgs.slice(-10).map((m) => `${who(m.userId)}: ${m.body.slice(0, 300)}`);
    const ok = await sendMail({
      to: u.email,
      subject: `${b.msgs.length === 1 ? `${who(b.msgs[0].userId)} messaged you` : `${b.msgs.length} new messages for you`} in ${where}`,
      text: `You have unread messages in ${where}:\n\n${lines.join("\n\n")}\n\nOpen Chat: ${link}\n\nTurn these emails off in Chat → Preferences.`,
      fromName: "IOTx Chat",
    });
    await db.channelMember.update({ where: { channelId_userId: { channelId: b.channelId, userId: b.userId } }, data: { emailedAt: now } });
    if (ok) n++;
  }
  return n;
}

// ── User groups ────────────────────────────────────────────────────────────

const handleOf = (s: unknown) => String(s ?? "").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const RESERVED = ["channel", "here", "everyone", "me"];

export async function listGroups(me: Me) {
  return db.userGroup.findMany({ where: { ws: me.ws }, orderBy: { handle: "asc" } });
}
export async function saveGroup(me: Me, id: string | null, b: { handle?: string; name?: string; memberIds?: string[] }) {
  const existing = id ? await db.userGroup.findUnique({ where: { id } }) : null;
  if (id && (!existing || existing.ws !== me.ws)) throw new HttpError(404, "Group not found");
  if (existing && existing.createdBy !== me.userId && !isAdmin(me)) throw new HttpError(403, "Only the group's creator or an admin can change it.");
  const handle = b.handle !== undefined ? handleOf(b.handle) : existing!.handle;
  if (!handle) bad("Give the group a handle, like @design.");
  if (RESERVED.includes(handle)) bad(`@${handle} is reserved.`);
  const clash = await db.userGroup.findFirst({ where: { ws: me.ws, handle, ...(id ? { id: { not: id } } : {}) } });
  if (clash) throw new HttpError(409, `@${handle} is already taken.`);
  const users = await db.user.findMany({ where: { id: { in: (await db.member.findMany({ where: { ws: me.ws } })).map((m) => m.userId) } } });
  if (users.some((u) => [u.name ?? "", u.email.split("@")[0]].some((h) => h.toLowerCase() === handle))) bad(`@${handle} is someone's name.`);
  const known = b.memberIds ? (await db.member.findMany({ where: { ws: me.ws, userId: { in: b.memberIds.slice(0, 500) } } })).map((m) => m.userId) : undefined;
  const data = { handle, name: String(b.name ?? existing?.name ?? handle).slice(0, 80) || handle, ...(known ? { memberIds: known } : {}) };
  return existing ? db.userGroup.update({ where: { id: existing.id }, data }) : db.userGroup.create({ data: { ...data, ws: me.ws, createdBy: me.userId, memberIds: known ?? [] } });
}
export async function deleteGroup(me: Me, id: string) {
  const g = await db.userGroup.findUnique({ where: { id } });
  if (!g || g.ws !== me.ws) throw new HttpError(404, "Group not found");
  if (g.createdBy !== me.userId && !isAdmin(me)) throw new HttpError(403, "Only the group's creator or an admin can delete it.");
  await db.userGroup.delete({ where: { id } });
  return { ok: true };
}

// ── Incoming webhooks ──────────────────────────────────────────────────────

export async function listHooks(me: Me, channelId: string) {
  const { member } = await loadChannel(me, channelId);
  if (!member && !isAdmin(me)) return [];
  const rows = await db.chatHook.findMany({ where: { channelId }, orderBy: { createdAt: "asc" } });
  return rows.map(({ token, ...h }) => ({ ...h, tail: token.slice(-4) }));
}
export async function createHook(me: Me, channelId: string, name: string) {
  const { ch, member } = await loadChannel(me, channelId);
  if (!member || ch.kind === "dm") throw new HttpError(403, "Join the channel to add an integration.");
  if ((await db.chatHook.count({ where: { channelId } })) >= 10) bad("A channel can have up to 10 webhooks.");
  const token = crypto.randomBytes(24).toString("base64url");
  const h = await db.chatHook.create({ data: { ws: me.ws, channelId, name: String(name ?? "").trim().slice(0, 60) || "Webhook", token, createdBy: me.userId } });
  // The token is shown once, in the URL.
  return { id: h.id, name: h.name, token };
}
export async function deleteHook(me: Me, id: string) {
  const h = await db.chatHook.findUnique({ where: { id } });
  if (!h || h.ws !== me.ws) throw new HttpError(404, "Webhook not found");
  const { member } = await loadChannel(me, h.channelId);
  if (h.createdBy !== me.userId && !isAdmin(me) && !member) throw new HttpError(403, "You can't remove this webhook.");
  await db.chatHook.delete({ where: { id } });
  return { ok: true };
}
/** POST /api/chat/hooks/<token> { text } — posts as the webhook. */
export async function postViaHook(token: string, text: string) {
  if (!token || token.length < 20) throw new HttpError(404, "Unknown webhook");
  const h = await db.chatHook.findFirst({ where: { token } });
  if (!h) throw new HttpError(404, "Unknown webhook");
  const me = { userId: h.createdBy, ws: h.ws, name: h.name, email: "", perms: {} } as unknown as Me;
  return postMessage(me, h.channelId, { body: String(text ?? "") }, { hookId: h.id });
}
