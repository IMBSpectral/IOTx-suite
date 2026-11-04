import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma, type Meeting } from "@prisma/client";
import { DataPacket_Kind } from "livekit-server-sdk";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad } from "../http";
import { notify } from "../notify";
import { breakoutRoom, joinToken, LIVEKIT_PUBLIC_URL, quiet, roomName, rooms, type MeetRole } from "./livekit";
import { breakoutOf, caller, hostLikeIdentity, isMember, MEET_KEYS, requireHostLike, requireIn, sendRoom, syncRoomMeta, type Caller } from "./meetings";
import { meteredFetch } from "../ai-meter";

/**
 * Meet extras: saved in-meeting chat (private messages and files), live
 * captions and the speaker transcript, polls, Q&A, breakout rooms, caption
 * translation, notes sent to attendees and the shared whiteboard.
 *
 * Live updates go out as LiveKit data messages (topics iotx.chat, iotx.poll,
 * iotx.qa, iotx.breakout); the browser then reads the state from here, so
 * nobody sees more than this server allows.
 */

/** Who may read a meeting's history: the host, members who joined, and invitees. */
export async function canSeeHistory(me: Me | null, m: Meeting) {
  if (!isMember(me, m)) return false;
  if (me.userId === m.hostId || m.invitees.includes(me.userId)) return true;
  return !!(await db.meetParticipant.findFirst({ where: { meetingId: m.id, userId: me.userId, status: "admitted" } }));
}
/** In the meeting now, or a member allowed to read its history afterwards. */
async function reader(me: Me | null, m: Meeting, guestKey?: string | null): Promise<Caller> {
  const c = await caller(me, m, guestKey);
  if (c?.admitted) return c;
  if (await canSeeHistory(me, m)) return c!;
  throw new HttpError(404, "Not found");
}

async function sendTo(room: string, topic: string, payload: unknown, to?: string[]) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  await quiet(() => rooms().sendData(room, data, DataPacket_Kind.RELIABLE, { topic, ...(to ? { destinationIdentities: to } : {}) })).catch(() => null);
}
const roomFor = (m: Meeting, n?: number) => (n ? breakoutRoom(m.id, n) : roomName(m.id));

// ── Chat ───────────────────────────────────────────────────────────────────

const FILES = path.join(process.cwd(), "storage", "meet-files");
type FileRef = { id: string; name: string; type: string; size: number };

function chatDto(r: { id: string; fromIdentity: string; fromName: string; toIdentity: string | null; toName: string | null; text: string; files: unknown; createdAt: Date }) {
  return { id: r.id, from: r.fromIdentity, fromName: r.fromName, to: r.toIdentity, toName: r.toName, text: r.text, files: (r.files as FileRef[] | null) ?? [], at: r.createdAt };
}

export async function listChat(me: Me | null, m: Meeting, guestKey?: string | null) {
  const c = await reader(me, m, guestKey);
  const rows = await db.meetChat.findMany({
    where: { meetingId: m.id, OR: [{ toIdentity: null }, { toIdentity: c.identity }, { fromIdentity: c.identity }] },
    orderBy: { createdAt: "asc" },
    take: 2000,
  });
  return rows.map(chatDto);
}

export async function postChat(me: Me | null, m: Meeting, guestKey: string | null, input: { text?: string; to?: string; fileIds?: string[]; room?: number }) {
  const c = await requireIn(me, m, guestKey);
  if (m.endedAt) bad("This meeting has ended.");
  const text = String(input.text ?? "").trim().slice(0, 2000);
  const fileIds = [...new Set((input.fileIds ?? []).map(String))].slice(0, 10);
  const files = fileIds.length ? await db.meetFile.findMany({ where: { id: { in: fileIds }, meetingId: m.id, identity: c.identity, used: false } }) : [];
  if (files.length !== fileIds.length) bad("A file couldn't be attached. Upload it again.");
  if (!text && !files.length) bad("Write a message first.");
  let to: { identity: string; name: string } | null = null;
  if (input.to) {
    const p = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity: String(input.to) } } });
    if (!p || p.status !== "admitted" || p.identity === c.identity) bad("You can only message someone in the meeting.");
    to = { identity: p.identity, name: p.name };
  }
  if (files.length) await db.meetFile.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { used: true } });
  const row = await db.meetChat.create({
    data: { meetingId: m.id, fromIdentity: c.identity, fromName: c.name, toIdentity: to?.identity ?? null, toName: to?.name ?? null, text, files: files.length ? files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size })) : Prisma.DbNull },
  });
  const dto = chatDto(row);
  const n = Number(input.room) || 0;
  await sendTo(roomFor(m, n), "iotx.chat", { type: "message", message: dto }, to ? [to.identity, c.identity] : undefined);
  // A private message sent from another room still reaches its person in the main room.
  if (to && n) await sendTo(roomName(m.id), "iotx.chat", { type: "message", message: dto }, [to.identity]);
  return dto;
}

export async function uploadMeetFile(me: Me | null, m: Meeting, guestKey: string | null, file: File) {
  const c = await requireIn(me, m, guestKey);
  if (!file.size) bad("Choose a file.");
  if (file.size > 25 * 1024 * 1024) bad("Files can be up to 25 MB.");
  if ((await db.meetFile.count({ where: { meetingId: m.id } })) >= 500) bad("This meeting has too many files.");
  const safe = (file.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const rel = path.join(m.id, `${crypto.randomUUID()}-${safe}`);
  await fs.mkdir(path.join(FILES, m.id), { recursive: true });
  await fs.writeFile(path.join(FILES, rel), Buffer.from(await file.arrayBuffer()));
  const row = await db.meetFile.create({ data: { meetingId: m.id, identity: c.identity, name: safe, type: (file.type || "application/octet-stream").slice(0, 100), size: file.size, path: rel } });
  return { id: row.id, name: row.name, type: row.type, size: row.size };
}

export async function readMeetFile(me: Me | null, m: Meeting, guestKey: string | null, id: string) {
  const c = await reader(me, m, guestKey);
  const f = await db.meetFile.findUnique({ where: { id } });
  if (!f || f.meetingId !== m.id) throw new HttpError(404, "File not found");
  if (!f.used && f.identity !== c.identity) throw new HttpError(404, "File not found");
  if (f.used) {
    // Files in a private message are only for its two people.
    const msg = await db.meetChat.findFirst({ where: { meetingId: m.id, files: { array_contains: [{ id }] } } });
    if (msg?.toIdentity && msg.toIdentity !== c.identity && msg.fromIdentity !== c.identity) throw new HttpError(404, "File not found");
  }
  return { f, data: await fs.readFile(path.join(FILES, f.path)) };
}

// ── Captions and the transcript ─────────────────────────────────────────────

export async function addCaption(me: Me | null, m: Meeting, guestKey: string | null, text: string) {
  const c = await requireIn(me, m, guestKey);
  if (m.e2ee) throw new HttpError(409, "Captions are off in end-to-end encrypted meetings.");
  if (!m.captions) throw new HttpError(409, "Captions are off in this meeting.");
  const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!t) bad("Nothing to add.");
  const row = await db.meetCaption.create({ data: { meetingId: m.id, identity: c.identity, name: c.name, text: t } });
  return { id: row.id, at: row.at };
}

export async function transcript(me: Me | null, m: Meeting, guestKey?: string | null) {
  await reader(me, m, guestKey);
  const lines = await db.meetCaption.findMany({ where: { meetingId: m.id }, orderBy: { at: "asc" }, take: 20000 });
  return lines.map((l) => ({ id: l.id, identity: l.identity, name: l.name, text: l.text, at: l.at }));
}

export const transcriptText = (lines: { name: string; text: string; at: Date }[]) => lines.map((l) => `[${l.at.toISOString().slice(11, 16)}] ${l.name}: ${l.text}`).join("\n");

/** AI notes from the live captions (no recording needed). */
export async function notesFromCaptions(m: Meeting, explicit = true) {
  const lines = await db.meetCaption.findMany({ where: { meetingId: m.id }, orderBy: { at: "asc" }, take: 20000 });
  if (lines.length < 2) {
    if (explicit) bad("There aren't enough captions to write notes from. Turn captions on and talk first.");
    return null;
  }
  if (!explicit && (m.notesStatus || (await db.meetRecording.count({ where: { meetingId: m.id, kind: "audio" } })))) return null;
  const { writeNotes } = await import("./notes");
  const text = transcriptText(lines);
  await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "processing", notesError: "", transcript: text } });
  // The report is re-made from the caption lines as they are now.
  await db.meetSegment.deleteMany({ where: { meetingId: m.id } });
  void writeNotes(m.id, text).catch(async (e) => {
    await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "failed", notesError: e instanceof HttpError ? e.message : "Something went wrong while writing the notes." } });
  });
  return { ok: true };
}

let ai: Anthropic | null = null;
const g = globalThis as unknown as { __meetTr?: Map<string, number[]> };
const trRate: Map<string, number[]> = (g.__meetTr ??= new Map());

/** Caption lines translated for one viewer (Claude Haiku 5.5). */
export async function translate(me: Me | null, m: Meeting, guestKey: string | null, input: { lines?: string[]; lang?: string }) {
  const c = await requireIn(me, m, guestKey);
  if (m.e2ee) throw new HttpError(409, "Translation is off in end-to-end encrypted meetings.");
  const lang = String(input.lang ?? "").trim();
  if (!/^[A-Za-z][A-Za-z ()-]{1,40}$/.test(lang)) bad("Pick a language.");
  const lines = (input.lines ?? []).map((l) => String(l).slice(0, 500)).filter(Boolean).slice(0, 20);
  if (!lines.length) return { lines: [] };
  const now = Date.now();
  const hits = (trRate.get(c.identity) ?? []).filter((t: number) => now - t < 60_000);
  if (hits.length >= 60) throw new HttpError(429, "Translation is busy. Wait a moment.");
  trRate.set(c.identity, [...hits, now]);
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "Translation isn't set up on this server.");
  try {
    const r = await (ai ??= new Anthropic({ fetch: meteredFetch("Meet: extras") })).messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 2000,
      system: `You translate live meeting captions into ${lang}. Reply with only a JSON array of strings: one translation per input line, same order, same count. Keep names as they are.`,
      messages: [{ role: "user", content: JSON.stringify(lines) }],
    });
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as unknown[];
    return { lines: lines.map((l, i) => (typeof arr[i] === "string" ? (arr[i] as string) : l)) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `Translation failed (${e.status ?? "error"}).`);
    throw new HttpError(502, "Translation failed.");
  }
}

// ── Polls ──────────────────────────────────────────────────────────────────

export async function listPolls(me: Me | null, m: Meeting, guestKey?: string | null) {
  const c = await reader(me, m, guestKey);
  const polls = await db.meetPoll.findMany({ where: { meetingId: m.id, ...(c.hostLike ? {} : { status: { not: "draft" } }) }, include: { votes: true }, orderBy: { createdAt: "asc" } });
  return polls.map((p) => {
    const showResults = c.hostLike || p.shared || (p.status === "closed" && p.shared);
    const counts = p.options.map((_, i) => p.votes.filter((v) => v.choices.includes(i)).length);
    const mine = p.votes.find((v) => v.identity === c.identity)?.choices ?? null;
    return {
      id: p.id, question: p.question, options: p.options, multi: p.multi, anonymous: p.anonymous, status: p.status, shared: p.shared,
      voted: p.votes.length, mine,
      results: showResults ? counts : null,
      voters: showResults && !p.anonymous && c.hostLike ? p.votes.map((v) => ({ name: v.name, choices: v.choices })) : null,
    };
  });
}

export async function pollAction(me: Me | null, m: Meeting, guestKey: string | null, b: { action?: string; id?: string; question?: string; options?: string[]; multi?: boolean; anonymous?: boolean; open?: boolean; choices?: number[] }) {
  if (b.action === "vote") {
    const c = await requireIn(me, m, guestKey);
    const p = await db.meetPoll.findUnique({ where: { id: String(b.id ?? "") } });
    if (!p || p.meetingId !== m.id) throw new HttpError(404, "Poll not found");
    if (p.status !== "open") bad("This poll isn't open.");
    const choices = [...new Set((b.choices ?? []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < p.options.length);
    if (!choices.length) bad("Pick an answer.");
    if (!p.multi && choices.length > 1) bad("Pick one answer.");
    await db.meetVote.upsert({ where: { pollId_identity: { pollId: p.id, identity: c.identity } }, create: { pollId: p.id, identity: c.identity, name: c.name, choices }, update: { choices, at: new Date() } });
    await sendRoom(m, "iotx.poll", { type: "vote", id: p.id });
    return { ok: true };
  }
  const c = await requireHostLike(me, m, guestKey);
  if (b.action === "create") {
    const question = String(b.question ?? "").trim().slice(0, 300);
    const options = (b.options ?? []).map((o) => String(o).trim().slice(0, 120)).filter(Boolean);
    if (!question) bad("Write the question.");
    if (options.length < 2 || options.length > 10) bad("A poll has 2 to 10 answers.");
    const p = await db.meetPoll.create({ data: { meetingId: m.id, question, options, multi: !!b.multi, anonymous: b.anonymous !== false, status: b.open ? "open" : "draft", createdBy: c.identity } });
    if (b.open) await sendRoom(m, "iotx.poll", { type: "open", id: p.id, question });
    return { id: p.id };
  }
  const p = await db.meetPoll.findUnique({ where: { id: String(b.id ?? "") } });
  if (!p || p.meetingId !== m.id) throw new HttpError(404, "Poll not found");
  const data: Prisma.MeetPollUpdateInput = {};
  if (b.action === "open") data.status = "open";
  else if (b.action === "close") data.status = "closed";
  else if (b.action === "share") data.shared = true;
  else if (b.action === "unshare") data.shared = false;
  else if (b.action === "delete") {
    await db.meetPoll.delete({ where: { id: p.id } });
    await sendRoom(m, "iotx.poll", { type: "refresh" });
    return { ok: true };
  } else bad("Unknown poll action.");
  await db.meetPoll.update({ where: { id: p.id }, data });
  await sendRoom(m, "iotx.poll", { type: b.action, id: p.id, question: p.question });
  return { ok: true };
}

// ── Q&A ────────────────────────────────────────────────────────────────────

export async function listQuestions(me: Me | null, m: Meeting, guestKey?: string | null) {
  const c = await reader(me, m, guestKey);
  const qs = await db.meetQuestion.findMany({ where: { meetingId: m.id, ...(c.hostLike ? {} : { status: { not: "dismissed" } }) }, orderBy: { createdAt: "asc" } });
  return qs
    .map((q) => ({
      id: q.id, text: q.text, name: q.anonymous ? "Anonymous" : q.name, mine: q.identity === c.identity, anonymous: q.anonymous,
      votes: q.upvotes.length, upvoted: q.upvotes.includes(c.identity), answer: q.answer, status: q.status, at: q.createdAt,
    }))
    .sort((a, b) => Number(a.status === "answered") - Number(b.status === "answered") || b.votes - a.votes);
}

export async function questionAction(me: Me | null, m: Meeting, guestKey: string | null, b: { action?: string; id?: string; text?: string; anonymous?: boolean; answer?: string }) {
  const c = await requireIn(me, m, guestKey);
  if (b.action === "ask") {
    const text = String(b.text ?? "").trim().slice(0, 500);
    if (!text) bad("Write your question.");
    if ((await db.meetQuestion.count({ where: { meetingId: m.id, identity: c.identity } })) >= 30) bad("You've asked a lot of questions. Wait for answers first.");
    const q = await db.meetQuestion.create({ data: { meetingId: m.id, identity: c.identity, name: c.name, anonymous: !!b.anonymous, text } });
    await sendRoom(m, "iotx.qa", { type: "ask", id: q.id });
    return { id: q.id };
  }
  const q = await db.meetQuestion.findUnique({ where: { id: String(b.id ?? "") } });
  if (!q || q.meetingId !== m.id) throw new HttpError(404, "Question not found");
  if (b.action === "upvote") {
    if (q.identity === c.identity) bad("You can't upvote your own question.");
    const upvotes = q.upvotes.includes(c.identity) ? q.upvotes.filter((x) => x !== c.identity) : [...q.upvotes, c.identity];
    await db.meetQuestion.update({ where: { id: q.id }, data: { upvotes } });
  } else if (b.action === "delete" && q.identity === c.identity && !c.hostLike) {
    await db.meetQuestion.delete({ where: { id: q.id } });
  } else {
    if (!c.hostLike) throw new HttpError(403, "Only hosts can do that.");
    if (b.action === "answer") {
      const answer = String(b.answer ?? "").trim().slice(0, 1000);
      await db.meetQuestion.update({ where: { id: q.id }, data: { answer, status: "answered", answeredBy: c.identity } });
    } else if (b.action === "dismiss") await db.meetQuestion.update({ where: { id: q.id }, data: { status: "dismissed" } });
    else if (b.action === "reopen") await db.meetQuestion.update({ where: { id: q.id }, data: { status: "open" } });
    else if (b.action === "delete") await db.meetQuestion.delete({ where: { id: q.id } });
    else bad("Unknown action.");
  }
  await sendRoom(m, "iotx.qa", { type: b.action, id: q.id });
  return { ok: true };
}

// ── Breakout rooms ─────────────────────────────────────────────────────────

type Bo = { open: boolean; rooms: { n: number; name: string; members: string[] }[]; allowChoose: boolean; message?: string };

export async function breakoutState(me: Me | null, m: Meeting, guestKey?: string | null) {
  const c = await requireIn(me, m, guestKey);
  const bo = breakoutOf(m) as Bo | null;
  if (!bo) return { breakout: null, mine: null, hostLike: c.hostLike };
  const mine = bo.rooms.find((r) => r.members.includes(c.identity))?.n ?? null;
  const names = c.hostLike ? await db.meetParticipant.findMany({ where: { meetingId: m.id, identity: { in: bo.rooms.flatMap((r) => r.members) } }, select: { identity: true, name: true } }) : [];
  return {
    breakout: {
      open: bo.open, allowChoose: bo.allowChoose,
      rooms: bo.rooms.map((r) => ({ n: r.n, name: r.name, count: r.members.length, ...(c.hostLike ? { members: r.members.map((i) => ({ identity: i, name: names.find((x) => x.identity === i)?.name ?? "Someone" })) } : {}) })),
    },
    mine,
    hostLike: c.hostLike,
  };
}

async function saveBo(m: Meeting, bo: Bo | null) {
  const u = await db.meeting.update({ where: { id: m.id }, data: { breakout: bo ? (bo as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  await syncRoomMeta(u);
  return u;
}

export async function closeBreakoutRooms(m: Meeting) {
  const bo = breakoutOf(m) as Bo | null;
  if (!bo) return;
  for (const r of bo.rooms) {
    await sendTo(breakoutRoom(m.id, r.n), "iotx.breakout", { type: "close" });
  }
}

export async function breakoutAction(me: Me | null, m: Meeting, guestKey: string | null, b: { action?: string; count?: number; auto?: boolean; allowChoose?: boolean; names?: string[]; identity?: string; n?: number | null; text?: string; identities?: string[] }) {
  if (b.action === "token") return breakoutToken(me, m, guestKey, Number(b.n) || 0);
  const c = await requireHostLike(me, m, guestKey);
  let bo = breakoutOf(m) as Bo | null;
  switch (b.action) {
    case "create": {
      if (m.kind === "webinar") bad("Webinars don't have breakout rooms.");
      if (bo?.open) bad("Close the open breakout rooms first.");
      const count = Math.round(Number(b.count));
      if (!(count >= 1 && count <= 50)) bad("Make 1 to 50 rooms.");
      const rooms_ = Array.from({ length: count }, (_, i) => ({ n: i + 1, name: String(b.names?.[i] ?? "").trim().slice(0, 60) || `Room ${i + 1}`, members: [] as string[] }));
      if (b.auto) {
        // Everyone in the meeting except hosts, spread evenly.
        const people = (b.identities?.length ? b.identities : ((await quiet(() => rooms().listParticipants(roomName(m.id)))) ?? []).map((p) => p.identity)).filter((i) => !hostLikeIdentity(m, i));
        const admitted = new Set((await db.meetParticipant.findMany({ where: { meetingId: m.id, status: "admitted", identity: { in: people } } })).map((p) => p.identity));
        [...people].filter((i) => admitted.has(i)).sort(() => Math.random() - 0.5).forEach((id, i) => rooms_[i % count].members.push(id));
      }
      bo = { open: false, rooms: rooms_, allowChoose: !!b.allowChoose };
      await saveBo(m, bo);
      return breakoutState(c.me, await db.meeting.findUniqueOrThrow({ where: { id: m.id } }), guestKey);
    }
    case "assign": {
      if (!bo) bad("Create breakout rooms first.");
      const id = String(b.identity ?? "");
      const p = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity: id } } });
      if (!p || p.status !== "admitted") bad("They need to be in the meeting.");
      for (const r of bo.rooms) r.members = r.members.filter((x) => x !== id);
      const n = b.n == null ? null : Number(b.n);
      if (n !== null) {
        const r = bo.rooms.find((x) => x.n === n);
        if (!r) bad("There's no such room.");
        r.members.push(id);
      }
      await saveBo(m, bo);
      if (bo.open) await sendTo(roomName(m.id), "iotx.breakout", { type: "moved", identity: id, n }, [id]);
      if (bo.open) for (const r of bo.rooms) await sendTo(breakoutRoom(m.id, r.n), "iotx.breakout", { type: "moved", identity: id, n }, [id]);
      return { ok: true };
    }
    case "options": {
      if (!bo) bad("Create breakout rooms first.");
      if (typeof b.allowChoose === "boolean") bo.allowChoose = b.allowChoose;
      await saveBo(m, bo);
      return { ok: true };
    }
    case "open": {
      if (!bo) bad("Create breakout rooms first.");
      for (const r of bo.rooms) await rooms().createRoom({ name: breakoutRoom(m.id, r.n), emptyTimeout: 600, departureTimeout: 20, maxParticipants: 100 });
      bo.open = true;
      await saveBo(m, bo);
      await sendTo(roomName(m.id), "iotx.breakout", { type: "open" });
      return { ok: true };
    }
    case "broadcast": {
      if (!bo?.open) bad("Open the breakout rooms first.");
      const text = String(b.text ?? "").trim().slice(0, 500);
      if (!text) bad("Write a message.");
      for (const r of bo.rooms) await sendTo(breakoutRoom(m.id, r.n), "iotx.breakout", { type: "message", text, from: c.name });
      await sendTo(roomName(m.id), "iotx.breakout", { type: "message", text, from: c.name });
      return { ok: true };
    }
    case "close": {
      if (!bo) return { ok: true };
      await closeBreakoutRooms(m);
      bo.open = false;
      await saveBo(m, bo);
      return { ok: true };
    }
    case "delete": {
      if (bo?.open) await closeBreakoutRooms(m);
      await saveBo(m, null);
      return { ok: true };
    }
    default:
      bad("Unknown breakout action.");
  }
}

/** A token for breakout room n (0 = back to the main room). */
async function breakoutToken(me: Me | null, m: Meeting, guestKey: string | null, n: number) {
  const c = await requireIn(me, m, guestKey);
  if (m.endedAt) bad("This meeting has ended.");
  const role: MeetRole = c.identity === `u_${m.hostId}` ? "host" : m.coHosts.includes(c.identity) ? "cohost" : c.p?.kind === "guest" ? "guest" : "member";
  if (n === 0) return { token: await joinToken({ room: roomName(m.id), identity: c.identity, name: c.name, role }), url: LIVEKIT_PUBLIC_URL, room: 0, role };
  const bo = breakoutOf(m) as Bo | null;
  const r = bo?.rooms.find((x) => x.n === n);
  if (!bo?.open || !r) bad("That breakout room isn't open.");
  if (!c.hostLike && !bo.allowChoose && !r.members.includes(c.identity)) throw new HttpError(403, "You aren't assigned to that room.");
  if (!r.members.includes(c.identity) && !c.hostLike) {
    for (const x of bo.rooms) x.members = x.members.filter((i) => i !== c.identity);
    r.members.push(c.identity);
    await saveBo(m, bo);
  }
  return { token: await joinToken({ room: breakoutRoom(m.id, n), identity: c.identity, name: c.name, role }), url: LIVEKIT_PUBLIC_URL, room: n, name: r.name, role };
}

// ── Notes to attendees ─────────────────────────────────────────────────────

export async function sendNotes(me: Me | null, m: Meeting) {
  const { requireRecorder } = await import("./recording");
  const host = requireRecorder(me, m, "audio");
  if (m.notesStatus !== "ready" || !m.notes) bad("The notes aren't ready yet.");
  const { notesText } = await import("./notes");
  const { sendMail } = await import("../cal-mail");
  const joined = await db.meetParticipant.findMany({ where: { meetingId: m.id, kind: "member", status: "admitted" } });
  const people = [...new Set([...m.invitees, ...joined.map((p) => p.userId!).filter(Boolean)])].filter((u) => u !== host.userId);
  const users = await db.user.findMany({ where: { id: { in: people } } });
  const base = (process.env.WORKSPACE_PUBLIC_URL || process.env.APP_URL || "").replace(/\/$/, "");
  const link = `${base}/workspace/meet/${m.code}/notes`;
  const body = notesText(m, m.notes as never);
  let emailed = 0;
  for (const u of users) {
    await notify({ ws: m.ws, userId: u.id, kind: "meet.notes", title: `Notes from ${m.title}`, body: (m.notes as { summary?: string }).summary?.slice(0, 200) ?? "", link: `/meet/${m.code}/notes`, key: `meet-notes-sent:${m.id}:${u.id}:${Date.now()}` });
    if (u.email && (await sendMail({ to: u.email, subject: `Notes: ${m.title}`, text: `${body}\n\nRecordings, transcript and chat: ${link}`, fromName: "IOTx Meet" }))) emailed++;
  }
  await db.meeting.update({ where: { id: m.id }, data: { notesSentAt: new Date() } });
  return { ok: true, people: users.length, emailed };
}

// ── Whiteboard (saved per meeting; readable afterwards on the notes page) ──

export const BOARD_KINDS = ["pen", "rect", "ellipse", "line", "arrow", "text"] as const;
type BoardKind = (typeof BOARD_KINDS)[number];
export type BoardItem = {
  id: string; kind: BoardKind; color: string; size: number; erase?: boolean;
  points?: number[]; x1?: number; y1?: number; x2?: number; y2?: number; x?: number; y?: number; text?: string; by?: string;
};
const unit = (v: unknown) => Math.min(1, Math.max(0, Math.round(Number(v) * 10000) / 10000));
const finite = (v: unknown) => Number.isFinite(Number(v));

/** A drawing item from the browser, checked and trimmed (coordinates are 0..1 of the board). */
function cleanItem(raw: Partial<BoardItem> & { erase?: boolean }): BoardItem {
  const kind = (BOARD_KINDS as readonly string[]).includes(String(raw.kind)) ? (raw.kind as BoardKind) : "pen";
  const item: BoardItem = {
    id: String(raw.id ?? crypto.randomUUID()).replace(/[^\w-]/g, "").slice(0, 40) || crypto.randomUUID(),
    kind,
    color: /^#[0-9a-f]{6}$/i.test(String(raw.color)) ? String(raw.color) : "#111111",
    size: Math.min(40, Math.max(1, Number(raw.size) || 3)),
  };
  if (kind === "pen") {
    const points = (raw.points ?? []).filter(finite).slice(0, 4000).map(unit);
    if (points.length < 2) bad("Draw something.");
    item.points = points.length % 2 ? points.slice(0, -1) : points;
    if (raw.erase) item.erase = true;
  } else if (kind === "text") {
    const text = String(raw.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text || !finite(raw.x) || !finite(raw.y)) bad("Type some text.");
    Object.assign(item, { text, x: unit(raw.x), y: unit(raw.y) });
  } else {
    if (![raw.x1, raw.y1, raw.x2, raw.y2].every(finite)) bad("Draw a shape.");
    Object.assign(item, { x1: unit(raw.x1), y1: unit(raw.y1), x2: unit(raw.x2), y2: unit(raw.y2) });
  }
  return item;
}

const itemDto = (r: { key: string; kind: string; data: unknown; identity: string }) => ({ ...(r.data as object), id: r.key, kind: r.kind, by: r.identity }) as BoardItem;

/** The board: anyone in the meeting, and afterwards the people who can read its history. */
export async function board(me: Me | null, m: Meeting, guestKey: string | null) {
  const c = await caller(me, m, guestKey);
  if (!c?.admitted && !(await canSeeHistory(me, m))) throw new HttpError(403, "Join the meeting first.");
  const rows = await db.meetBoardItem.findMany({ where: { meetingId: m.id, deleted: false }, orderBy: { createdAt: "asc" }, take: 5000 });
  return rows.map(itemDto);
}

/**
 * POST { item } (or the older { stroke }) adds one; { action: "undo" } takes back my latest;
 * { action: "remove", id } removes one of mine (hosts: anyone's); { action: "clear" } (hosts).
 * Live drawing goes over the data channel; this keeps the saved copy.
 */
export async function boardAction(me: Me | null, m: Meeting, guestKey: string | null, b: { action?: string; stroke?: Partial<BoardItem>; item?: Partial<BoardItem>; id?: string }) {
  const c = await requireIn(me, m, guestKey);
  if (m.endedAt) bad("This meeting has ended. The whiteboard is saved as it was.");
  if (m.kind === "webinar" && !c.hostLike && !m.stage.includes(c.identity) && !(c.me && m.panelists.includes(c.me.userId))) throw new HttpError(403, "Only people on stage can draw.");
  if (b.action === "clear") {
    if (!c.hostLike) throw new HttpError(403, "Only hosts can clear the whiteboard.");
    await db.meetBoardItem.updateMany({ where: { meetingId: m.id, deleted: false }, data: { deleted: true } });
    await sendRoom(m, "iotx.board", { type: "clear" });
    return { ok: true };
  }
  if (b.action === "undo" || b.action === "remove") {
    const row = b.action === "undo"
      ? await db.meetBoardItem.findFirst({ where: { meetingId: m.id, identity: c.identity, deleted: false }, orderBy: { createdAt: "desc" } })
      : await db.meetBoardItem.findUnique({ where: { meetingId_key: { meetingId: m.id, key: String(b.id ?? "") } } });
    if (!row || row.deleted) return { ok: true, id: null };
    if (row.identity !== c.identity && !c.hostLike) throw new HttpError(403, "You can only remove your own drawing.");
    await db.meetBoardItem.update({ where: { id: row.id }, data: { deleted: true } });
    await sendRoom(m, "iotx.board", { type: "remove", id: row.key });
    return { ok: true, id: row.key };
  }
  const item = cleanItem(b.item ?? b.stroke ?? {});
  if ((await db.meetBoardItem.count({ where: { meetingId: m.id } })) >= 5000) bad("The whiteboard is full. A host can clear it.");
  const { id, kind, ...data } = item;
  await db.meetBoardItem.upsert({
    where: { meetingId_key: { meetingId: m.id, key: id } },
    create: { meetingId: m.id, key: id, identity: c.identity, kind, data: data as Prisma.InputJsonValue },
    update: {},
  });
  return { ok: true, id };
}

export async function canUseAiNotes(me: Me | null, m: Meeting) {
  return isMember(me, m) && hostLikeIdentity(m, `u_${me.userId}`) && can(me, MEET_KEYS.aiNotes);
}
