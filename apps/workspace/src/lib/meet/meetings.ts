import crypto from "node:crypto";
import { Prisma, type Meeting, type MeetParticipant } from "@prisma/client";
import { DataPacket_Kind, TrackType } from "livekit-server-sdk";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad } from "../http";
import { notify } from "../notify";
import { publish } from "../bus";
import { LIVEKIT_PUBLIC_URL, joinToken, quiet, roomName, rooms, type MeetRole } from "./livekit";
import { dialInInfo, dropDialRule, ensureDialRule, newDialIn } from "./sip";

/**
 * IOTx Meet: meetings, the waiting room and host controls.
 *
 * Members of the meeting's workspace join with their Workspace session.
 * Anyone else joins as a guest with just a name (and the passcode, if the
 * meeting has one): they get a secret key (kept by their browser, stored here
 * only as a hash) and wait until a host admits them, unless the waiting room
 * is off. With "everyone waits", members wait too.
 *
 * Hosts are the meeting's creator plus any co-hosts (by LiveKit identity, so
 * a guest can be a co-host). Hosts admit people, mute, remove, lock,
 * spotlight and run breakout rooms, polls and captions through this server,
 * which calls LiveKit's room service; tokens never carry admin or recording
 * rights. When the last host leaves, someone still in the room is made a
 * co-host so the waiting room never gets stuck.
 */

export const MEET_KEYS = {
  open: "meetings.open",
  create: "meetings.create",
  guests: "meetings.guests",
  record: "meetings.record",
  aiNotes: "meetings.ai_notes",
} as const;

const LETTERS = "abcdefghijkmnopqrstuvwxyz";
export function newCode() {
  const pick = (n: number) => Array.from(crypto.randomBytes(n), (b) => LETTERS[b % LETTERS.length]).join("");
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}
export const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export const hashKey = (k: string) => crypto.createHash("sha256").update(k).digest("hex");

export type MeetingSettings = {
  waitingRoom?: boolean; allowGuests?: boolean; muteOnEntry?: boolean; locked?: boolean; everyoneWaits?: boolean; passcode?: string | null; captionLang?: string;
  /** End-to-end encryption: the browser makes the key; the server only keeps a check value. */
  e2ee?: boolean; e2eeCheck?: string | null;
  /** Webinars. */
  registration?: boolean; regApproval?: boolean; startsAt?: string | null;
};

const cleanPasscode = (v: unknown) => {
  if (v === null || v === "") return null;
  const s = String(v ?? "").trim();
  if (!/^[A-Za-z0-9]{4,10}$/.test(s)) bad("A passcode is 4 to 10 letters or digits.");
  return s;
};
const cleanCheck = (v: unknown) => {
  const s = String(v ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) bad("Encryption needs a key made by your browser. Reload and try again.");
  return s;
};
const cleanStart = (v: unknown) => {
  if (v === null || v === "" || v === undefined) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) bad("Pick a valid start time.");
  return d;
};

/** Webinars hold up to this many people (LiveKit's room limit). */
export const WEBINAR_CAP = Math.max(10, Number(process.env.MEET_WEBINAR_CAP) || 1000);

export async function createMeeting(
  me: Me,
  input: { title?: string; eventId?: string | null; channelId?: string | null; invitees?: string[]; personal?: boolean; kind?: string; panelists?: string[] } & MeetingSettings,
) {
  if (!can(me, MEET_KEYS.create)) throw new HttpError(403, "Your role can't start meetings. Ask an admin to turn on Meet.", { key: MEET_KEYS.create });
  const webinar = input.kind === "webinar";
  const title = String(input.title ?? "").trim().slice(0, 200) || (webinar ? `${me.name}'s webinar` : `${me.name}'s meeting`);
  const known = input.invitees?.length ? await db.member.findMany({ where: { ws: me.ws, userId: { in: input.invitees.slice(0, 200) } } }) : [];
  const allowGuests = input.allowGuests !== false && can(me, MEET_KEYS.guests);
  const passcode = input.passcode === undefined ? null : cleanPasscode(input.passcode);
  if (webinar && input.e2ee) bad("Webinars can't be end-to-end encrypted (registration, streaming and the audience need the server).");
  const e2eeCheck = input.e2ee ? cleanCheck(input.e2eeCheck) : null;
  // Panelists: workspace members, by user id or email.
  const wanted = (input.panelists ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 50);
  const panelists = webinar && wanted.length ? await panelistIds(me.ws, wanted) : [];
  const dial = await newDialIn();
  for (let i = 0; i < 5; i++) {
    try {
      return await db.meeting.create({
        data: {
          kind: webinar ? "webinar" : "meeting",
          e2ee: !!e2eeCheck,
          e2eeCheck,
          startsAt: webinar ? cleanStart(input.startsAt) : null,
          registration: webinar && !!input.registration,
          regApproval: webinar && !!input.registration && !!input.regApproval,
          panelists: panelists.filter((u) => u !== me.userId),
          ...dial,
          ws: me.ws,
          code: newCode(),
          title,
          hostId: me.userId,
          eventId: input.eventId ?? null,
          channelId: input.channelId ?? null,
          invitees: [...new Set(known.map((k) => k.userId))].filter((u) => u !== me.userId),
          waitingRoom: input.waitingRoom !== false,
          allowGuests,
          muteOnEntry: !!input.muteOnEntry,
          everyoneWaits: !!input.everyoneWaits,
          passcode,
          personal: !!input.personal,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e; // code collision: try another
    }
  }
  throw new HttpError(500, "Couldn't create a meeting code. Try again.");
}

/** Workspace members named by user id or email (others are ignored). */
export async function panelistIds(ws: string, wanted: string[]) {
  const users = await db.user.findMany({ where: { OR: [{ id: { in: wanted } }, { email: { in: wanted, mode: "insensitive" } }] }, select: { id: true } });
  const ms = await db.member.findMany({ where: { ws, userId: { in: users.map((u) => u.id) } }, select: { userId: true } });
  return [...new Set(ms.map((x) => x.userId))];
}

/** My personal meeting room: one fixed link, created the first time. */
export async function personalRoom(me: Me) {
  const existing = await db.meeting.findFirst({ where: { ws: me.ws, hostId: me.userId, personal: true } });
  if (existing) return existing;
  return createMeeting(me, { title: `${me.name}'s room`, personal: true });
}

export async function byCode(code: string) {
  const c = String(code ?? "").toLowerCase().trim();
  if (!CODE_RE.test(c)) throw new HttpError(404, "There's no meeting with that code.");
  const m = await db.meeting.findUnique({ where: { code: c } });
  if (!m) throw new HttpError(404, "There's no meeting with that code.");
  return m;
}

/** Members of the meeting's workspace (anyone else is a guest). */
export const isMember = (me: Me | null, m: Meeting): me is Me => !!me && me.ws === m.ws;
/** The meeting's owner (creator). */
export const isHost = (me: Me | null, m: Meeting) => isMember(me, m) && me.userId === m.hostId;
export const ownerIdentity = (m: Meeting) => `u_${m.hostId}`;
export const hostLikeIdentity = (m: Meeting, identity: string) => identity === ownerIdentity(m) || m.coHosts.includes(identity);

export function requireHost(me: Me | null, m: Meeting): Me {
  if (!isHost(me, m)) throw new HttpError(403, "Only the host can do that.");
  return me as Me;
}

/** Whoever is calling: a member (session) or a guest (key), with their record. */
export type Caller = { identity: string; name: string; me: Me | null; p: MeetParticipant | null; hostLike: boolean; owner: boolean; admitted: boolean };
export async function caller(me: Me | null, m: Meeting, guestKey?: string | null): Promise<Caller | null> {
  if (isMember(me, m) && !guestKey) {
    const identity = `u_${me.userId}`;
    const p = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity } } });
    const owner = me.userId === m.hostId;
    return { identity, name: me.name, me, p, owner, hostLike: hostLikeIdentity(m, identity), admitted: owner || p?.status === "admitted" };
  }
  if (guestKey) {
    const p = await db.meetParticipant.findFirst({ where: { meetingId: m.id, kind: "guest", keyHash: hashKey(String(guestKey)) } });
    if (!p) return null;
    return { identity: p.identity, name: p.name, me: null, p, owner: false, hostLike: p.status === "admitted" && m.coHosts.includes(p.identity), admitted: p.status === "admitted" };
  }
  return null;
}
export async function requireHostLike(me: Me | null, m: Meeting, guestKey?: string | null) {
  const c = await caller(me, m, guestKey);
  if (!c?.hostLike) throw new HttpError(403, "Only hosts can do that.");
  return c;
}
/** Someone admitted to the meeting (or its owner). */
export async function requireIn(me: Me | null, m: Meeting, guestKey?: string | null) {
  const c = await caller(me, m, guestKey);
  if (!c?.admitted) throw new HttpError(403, "Join the meeting first.");
  return c;
}

async function hostName(m: Meeting) {
  const u = await db.user.findUnique({ where: { id: m.hostId } });
  return u?.name ?? u?.email ?? "The host";
}

/** What the join page may show (anyone with the link). */
export async function publicInfo(m: Meeting, me: Me | null) {
  const member = isMember(me, m);
  return {
    code: m.code,
    title: m.title,
    host: await hostName(m),
    ended: !!m.endedAt,
    locked: m.locked,
    waitingRoom: m.waitingRoom,
    allowGuests: m.allowGuests,
    muteOnEntry: m.muteOnEntry,
    everyoneWaits: m.everyoneWaits,
    passcode: !!m.passcode,
    personal: m.personal,
    kind: m.kind as "meeting" | "webinar",
    // Only a check value: the key itself travels in the invite link's #fragment, which browsers never send.
    e2ee: m.e2ee,
    e2eeCheck: m.e2ee ? m.e2eeCheck : null,
    startsAt: m.startsAt ? m.startsAt.toISOString() : null,
    registration: m.registration,
    you: member
      ? { kind: "member" as const, name: me.name, host: me.userId === m.hostId, coHost: m.coHosts.includes(`u_${me.userId}`), panelist: m.kind === "webinar" && m.panelists.includes(me.userId) }
      : null,
  };
}

export function settingsDto(m: Meeting) {
  return {
    waitingRoom: m.waitingRoom, allowGuests: m.allowGuests, muteOnEntry: m.muteOnEntry, locked: m.locked, everyoneWaits: m.everyoneWaits, hasPasscode: !!m.passcode, captions: m.captions, captionLang: m.captionLang,
    kind: m.kind, e2ee: m.e2ee, registration: m.registration, regApproval: m.regApproval, startsAt: m.startsAt,
  };
}

type Breakout = { open: boolean; rooms: { n: number; name: string; members: string[] }[]; allowChoose: boolean; message?: string };
export const breakoutOf = (m: Meeting): Breakout | null => (m.breakout as Breakout | null) ?? null;

/** Room metadata everyone in the room reads (lock, recording, spotlight, co-hosts, captions, breakouts). */
export async function syncRoomMeta(m: Meeting) {
  const recs = await db.meetRecording.findMany({ where: { meetingId: m.id, status: { in: ["starting", "active"] } } });
  const live = await db.meetStream.count({ where: { meetingId: m.id, status: { in: ["starting", "active"] } } });
  const bo = breakoutOf(m);
  const meta = {
    kind: m.kind,
    e2ee: m.e2ee,
    stage: m.stage,
    live: live > 0,
    title: m.title,
    locked: m.locked,
    muteOnEntry: m.muteOnEntry,
    waitingRoom: m.waitingRoom,
    recording: recs.some((r) => r.kind === "video"),
    notes: recs.some((r) => r.kind === "audio"),
    host: ownerIdentity(m),
    coHosts: m.coHosts,
    spotlight: m.spotlight,
    captions: m.captions,
    captionLang: m.captionLang,
    breakout: bo ? { open: bo.open, rooms: bo.rooms.map((r) => ({ n: r.n, name: r.name, count: r.members.length })) } : null,
  };
  await quiet(() => rooms().updateRoomMetadata(roomName(m.id), JSON.stringify(meta)));
  return meta;
}

export async function ensureRoom(m: Meeting) {
  await rooms().createRoom({ name: roomName(m.id), emptyTimeout: 300, departureTimeout: 20, maxParticipants: m.kind === "webinar" ? WEBINAR_CAP + 50 : 100 });
  // Phone dial-in (only when LiveKit SIP is set up; meetings from before dial-in get their ID now).
  let mm = m;
  if (!m.dialInId) mm = await db.meeting.update({ where: { id: m.id }, data: await newDialIn() });
  void ensureDialRule(mm);
  return mm;
}

/** First person in (or the first after "End for all"): mark started and tell the invitees. */
export async function markStarted(m: Meeting, by: { userId?: string; name: string }) {
  if (m.startedAt && !m.endedAt) return m;
  const now = new Date();
  const upd = await db.meeting.update({ where: { id: m.id }, data: { startedAt: now, endedAt: null } });
  const people = new Set(m.invitees);
  if (m.eventId) {
    const att = await db.attendee.findMany({ where: { eventId: m.eventId, userId: { not: null }, response: { not: "no" } } });
    for (const a of att) if (a.userId) people.add(a.userId);
    const ev = await db.event.findUnique({ where: { id: m.eventId } });
    if (ev) people.add(ev.creatorId);
  }
  people.add(m.hostId);
  if (by.userId) people.delete(by.userId);
  for (const uid of people)
    await notify({ ws: m.ws, userId: uid, kind: "meet.started", title: `${m.title} has started`, body: `${by.name} is in the meeting. Join now.`, link: `/meet/${m.code}`, key: `meet:${m.id}:${now.getTime()}:${uid}` });
  return upd;
}

/** Host, co-host, or (webinars) panelist / attendee, else the base role. */
export function roleFor(m: Meeting, identity: string, base: MeetRole): MeetRole {
  if (identity === ownerIdentity(m)) return "host";
  if (m.coHosts.includes(identity)) return "cohost";
  if (m.kind !== "webinar") return base;
  if (m.stage.includes(identity)) return "panelist";
  if (identity.startsWith("u_") && m.panelists.includes(identity.slice(2))) return "panelist";
  return "attendee";
}

export function tokenReply(m: Meeting, p: MeetParticipant, token: string, role: MeetRole) {
  return {
    status: "admitted" as const,
    token,
    url: LIVEKIT_PUBLIC_URL,
    identity: p.identity,
    role,
    name: p.name,
    settings: settingsDto(m),
    // Only people let in see the phone details (a PIN skips the waiting room).
    dialIn: dialInInfo(m),
  };
}

/** A workspace member joins: straight in, unless locked, removed, or "everyone waits". */
export async function joinMember(me: Me, m: Meeting) {
  if (!isMember(me, m)) throw new HttpError(403, "Join as a guest.");
  const identity = `u_${me.userId}`;
  const owner = me.userId === m.hostId;
  const hostLike = hostLikeIdentity(m, identity);
  if (m.endedAt && !owner) throw new HttpError(409, "This meeting has ended. It opens again when the host rejoins.", { status: "ended" });
  const existing = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity } } });
  if (existing?.status === "removed" && !owner) throw new HttpError(403, "The host removed you from this meeting.", { status: "removed" });
  if (existing?.status === "denied" && !owner) throw new HttpError(403, "The host didn't let you in.", { status: "denied" });
  if (m.locked && !hostLike && existing?.status !== "admitted") throw new HttpError(423, "The host has locked this meeting.", { status: "locked" });
  const role = roleFor(m, identity, "member");
  if (m.everyoneWaits && m.kind !== "webinar" && !hostLike && existing?.status !== "admitted") {
    const p = await db.meetParticipant.upsert({
      where: { meetingId_identity: { meetingId: m.id, identity } },
      create: { meetingId: m.id, kind: "member", userId: me.userId, name: me.name, identity, role, status: "waiting" },
      update: { name: me.name },
    });
    if (!existing) await tellHostsAboutLobby(m, me.name);
    return { status: "waiting" as const, participantId: p.id };
  }
  const p = await db.meetParticipant.upsert({
    where: { meetingId_identity: { meetingId: m.id, identity } },
    create: { meetingId: m.id, kind: "member", userId: me.userId, name: me.name, identity, role, status: "admitted", joinedAt: new Date() },
    update: { name: me.name, role, status: "admitted", joinedAt: new Date() },
  });
  // Attendance per day (a recurring series reuses one meeting): For You and Recommendations count skips with it.
  void import("./read").then((r) => r.logAttendance(m.id, me.userId)).catch(() => {});
  const started = await markStarted(await ensureRoom(m), { userId: me.userId, name: me.name });
  await syncRoomMeta(started);
  return tokenReply(started, p, await joinToken({ room: roomName(m.id), identity, name: me.name, role }), role);
}

// Guest join requests per address per meeting: at most 8 a minute, 5 wrong passcodes in 10 minutes.
const g = globalThis as unknown as { __meetRate?: Map<string, number[]> };
const rate: Map<string, number[]> = (g.__meetRate ??= new Map());
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const hits = (rate.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rate.set(key, hits);
    return true;
  }
  hits.push(now);
  rate.set(key, hits);
  return false;
}
export { limited };
export const ipHashFor = (m: Meeting, ip: string) => crypto.createHash("sha256").update(`${m.id}:${ip}`).digest("hex");
export function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim().slice(0, 64);
}

/**
 * A guest asks to join (name only, plus the passcode if there is one) or
 * checks back with their key. Held in "waiting" until a host admits them
 * (unless the waiting room is off).
 */
export async function joinGuest(m: Meeting, input: { name?: string; key?: string; passcode?: string; reg?: string }, ip = "local") {
  if (!m.allowGuests) throw new HttpError(403, "This meeting is for members of the organization only. Sign in to join.", { status: "members_only" });
  // Webinars with registration: guests join with the link they were emailed.
  if (m.kind === "webinar" && input.reg && !input.key) {
    const { joinRegistrant } = await import("./webinar");
    return joinRegistrant(m, String(input.reg), ip);
  }
  if (input.key) {
    const p = await db.meetParticipant.findFirst({ where: { meetingId: m.id, kind: "guest", keyHash: hashKey(String(input.key)) } });
    if (!p) throw new HttpError(404, "We couldn't find your request. Ask to join again.", { status: "unknown" });
    if (p.status === "denied") throw new HttpError(403, "The host didn't let you in.", { status: "denied" });
    if (p.status === "removed") throw new HttpError(403, "The host removed you from this meeting.", { status: "removed" });
    if (m.endedAt) return { status: "waiting" as const, participantId: p.id, ended: true };
    if (p.status === "waiting") return { status: "waiting" as const, participantId: p.id };
    await db.meetParticipant.update({ where: { id: p.id }, data: { joinedAt: new Date() } });
    const started = await markStarted(await ensureRoom(m), { name: p.name });
    await syncRoomMeta(started);
    const role = roleFor(started, p.identity, "guest");
    return tokenReply(started, p, await joinToken({ room: roomName(m.id), identity: p.identity, name: p.name, role }), role);
  }
  if (m.kind === "webinar" && m.registration) throw new HttpError(403, "Register for this webinar first. Your join link comes by email.", { status: "register" });
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) bad("Enter your name to join.");
  if (m.locked) throw new HttpError(423, "The host has locked this meeting.", { status: "locked" });
  const ipHash = ipHashFor(m, ip);
  if (await db.meetParticipant.findFirst({ where: { meetingId: m.id, kind: "guest", ipHash, status: "removed" } }))
    throw new HttpError(403, "The host removed you from this meeting.", { status: "removed" });
  if (limited(`join:${m.id}:${ip}`, 8, 60_000)) throw new HttpError(429, "Too many requests to join. Wait a minute and try again.");
  if (m.passcode) {
    if (limited(`pass:${m.id}:${ip}`, 5, 10 * 60_000) && String(input.passcode ?? "") !== m.passcode) throw new HttpError(429, "Too many wrong passcodes. Try again in a few minutes.");
    if (String(input.passcode ?? "").trim() !== m.passcode) throw new HttpError(401, input.passcode ? "That passcode isn't right." : "This meeting needs a passcode.", { status: "passcode" });
  }
  const waiting = await db.meetParticipant.count({ where: { meetingId: m.id, status: "waiting" } });
  if (waiting >= 50) throw new HttpError(429, "Too many people are waiting to join. Try again in a minute.");
  const key = crypto.randomBytes(24).toString("base64url");
  const id = crypto.randomBytes(9).toString("base64url").replace(/[^a-zA-Z0-9]/g, "x");
  // Webinar attendees only watch, so they don't wait.
  const auto = !m.waitingRoom || m.kind === "webinar";
  const role = roleFor(m, `g_${id}`, "guest");
  const p = await db.meetParticipant.create({
    data: { meetingId: m.id, kind: "guest", name, identity: `g_${id}`, role, status: auto ? "admitted" : "waiting", keyHash: hashKey(key), ipHash, ...(auto ? { decidedBy: "auto", decidedAt: new Date() } : {}) },
  });
  if (!auto) await tellHostsAboutLobby(m, name);
  if (auto && !m.endedAt) {
    const started = await markStarted(await ensureRoom(m), { name });
    await syncRoomMeta(started);
    return { ...tokenReply(started, p, await joinToken({ room: roomName(m.id), identity: p.identity, name, role }), role), key };
  }
  return { status: "waiting" as const, participantId: p.id, key };
}

async function tellHostsAboutLobby(m: Meeting, name: string) {
  publish(`user:${m.hostId}`, { type: "meet.lobby", code: m.code, name });
  const data = new TextEncoder().encode(JSON.stringify({ type: "lobby", name }));
  await quiet(() => rooms().sendData(roomName(m.id), data, DataPacket_Kind.RELIABLE, { destinationIdentities: [ownerIdentity(m), ...m.coHosts], topic: "iotx.lobby" })).catch(() => null);
}

/** The waiting room (hosts). */
export async function lobby(me: Me | null, m: Meeting, guestKey?: string | null) {
  await requireHostLike(me, m, guestKey);
  const ps = await db.meetParticipant.findMany({ where: { meetingId: m.id, status: "waiting" }, orderBy: { createdAt: "asc" } });
  return ps.map((p) => ({ id: p.id, name: p.name, since: p.createdAt, kind: p.kind }));
}

export async function decide(me: Me | null, m: Meeting, input: { participantId?: string; all?: boolean; action?: string }, guestKey?: string | null) {
  const c = await requireHostLike(me, m, guestKey);
  const action = input.action === "deny" ? "denied" : input.action === "admit" ? "admitted" : bad("action must be admit or deny");
  const where = input.all ? { meetingId: m.id, status: "waiting" } : { id: String(input.participantId ?? ""), meetingId: m.id, status: "waiting" };
  const r = await db.meetParticipant.updateMany({ where, data: { status: action, decidedBy: c.identity, decidedAt: new Date() } });
  if (!input.all && r.count === 0) throw new HttpError(404, "That person isn't waiting any more.");
  return { ok: true, count: r.count };
}

export async function updateSettings(me: Me | null, m: Meeting, patch: MeetingSettings & { title?: string }, guestKey?: string | null) {
  const c = await requireHostLike(me, m, guestKey);
  const data: Record<string, unknown> = {};
  for (const k of ["waitingRoom", "muteOnEntry", "locked", "everyoneWaits"] as const) if (typeof patch[k] === "boolean") data[k] = patch[k];
  if (typeof patch.allowGuests === "boolean") {
    if (patch.allowGuests && !(c.me && can(c.me, MEET_KEYS.guests))) throw new HttpError(403, "Your role can't invite guests from outside.", { key: MEET_KEYS.guests });
    data.allowGuests = patch.allowGuests;
  }
  if (patch.passcode !== undefined) data.passcode = cleanPasscode(patch.passcode);
  if (typeof patch.captionLang === "string") {
    if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(patch.captionLang)) bad("Pick a caption language like en-US.");
    data.captionLang = patch.captionLang;
  }
  if (typeof patch.title === "string" && patch.title.trim()) data.title = patch.title.trim().slice(0, 200);
  if (typeof patch.e2ee === "boolean" && patch.e2ee !== m.e2ee) {
    if (!c.owner) throw new HttpError(403, "Only the host can change encryption.");
    if (m.kind === "webinar") bad("Webinars can't be end-to-end encrypted.");
    // Everyone in the room would be left with the wrong key: change it before anyone joins.
    const inRoom = (await quiet(() => rooms().listParticipants(roomName(m.id)))) ?? [];
    if (inRoom.length) throw new HttpError(409, "Change encryption before anyone joins (or after everyone has left).");
    if (patch.e2ee && (await db.meetRecording.count({ where: { meetingId: m.id, status: { in: ["starting", "active"] } } }))) bad("Stop the recording first.");
    data.e2ee = patch.e2ee;
    data.e2eeCheck = patch.e2ee ? cleanCheck(patch.e2eeCheck) : null;
    if (patch.e2ee) data.captions = false;
  }
  if (m.kind === "webinar") {
    if (typeof patch.registration === "boolean") data.registration = patch.registration;
    if (typeof patch.regApproval === "boolean") data.regApproval = patch.regApproval;
    if (patch.startsAt !== undefined) data.startsAt = cleanStart(patch.startsAt);
  }
  const u = await db.meeting.update({ where: { id: m.id }, data });
  if (data.e2ee === true) await dropDialRule(u);
  if (data.e2ee === false) void ensureDialRule(u);
  // Turning the waiting room off lets every guest who is waiting in; "everyone waits" off lets members in.
  if (data.waitingRoom === false) await db.meetParticipant.updateMany({ where: { meetingId: m.id, status: "waiting", kind: "guest" }, data: { status: "admitted", decidedBy: "auto", decidedAt: new Date() } });
  if (data.everyoneWaits === false) await db.meetParticipant.updateMany({ where: { meetingId: m.id, status: "waiting", kind: "member" }, data: { status: "admitted", decidedBy: "auto", decidedAt: new Date() } });
  await syncRoomMeta(u);
  return u;
}

async function setRoleMeta(m: Meeting, identity: string) {
  const p = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity } } });
  const role = roleFor(m, identity, (p?.kind === "guest" ? "guest" : "member") as MeetRole);
  await db.meetParticipant.updateMany({ where: { meetingId: m.id, identity }, data: { role } });
  // Webinars: the role decides whether they may publish (and whether they're hidden in the audience).
  const permission = m.kind === "webinar" ? { canPublish: role !== "attendee", canSubscribe: true, canPublishData: true, hidden: role === "attendee", canUpdateMetadata: false } : undefined;
  await quiet(() => rooms().updateParticipant(roomName(m.id), identity, { metadata: JSON.stringify({ role }), ...(permission ? { permission } : {}) }));
}
export { setRoleMeta };

async function sendRoom(m: Meeting, topic: string, payload: unknown, to?: string[]) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  await quiet(() => rooms().sendData(roomName(m.id), data, DataPacket_Kind.RELIABLE, { topic, ...(to ? { destinationIdentities: to } : {}) })).catch(() => null);
}
export { sendRoom };

/** Host controls through LiveKit's room service. */
export async function control(me: Me | null, m: Meeting, input: { action?: string; identity?: string; on?: boolean; lang?: string }, guestKey?: string | null) {
  const c = await requireHostLike(me, m, guestKey);
  const room = roomName(m.id);
  const svc = rooms();
  const target = String(input.identity ?? "");
  switch (input.action) {
    case "mute_all":
    case "mute": {
      const list = (await quiet(() => svc.listParticipants(room))) ?? [];
      let muted = 0;
      for (const p of list) {
        if (input.action === "mute" ? p.identity !== target : p.identity === c.identity || hostLikeIdentity(m, p.identity)) continue;
        for (const t of p.tracks) {
          if (t.type !== TrackType.AUDIO || t.muted) continue;
          await quiet(() => svc.mutePublishedTrack(room, p.identity, t.sid, true));
          muted++;
        }
      }
      return { ok: true, muted };
    }
    case "remove": {
      if (!target || target === ownerIdentity(m) || target === c.identity) bad("Pick someone to remove.");
      if (!c.owner && m.coHosts.includes(target)) throw new HttpError(403, "Only the host can remove a co-host.");
      await db.meetParticipant.updateMany({ where: { meetingId: m.id, identity: target }, data: { status: "removed", decidedBy: c.identity, decidedAt: new Date() } });
      if (m.coHosts.includes(target)) await db.meeting.update({ where: { id: m.id }, data: { coHosts: m.coHosts.filter((x) => x !== target), ...(m.spotlight === target ? { spotlight: null } : {}) } });
      await quiet(() => svc.removeParticipant(room, target));
      await syncRoomMeta(await db.meeting.findUniqueOrThrow({ where: { id: m.id } }));
      return { ok: true };
    }
    case "cohost": {
      // The host names co-hosts; co-hosts may also hand the role on when they leave (see handOver).
      if (!c.owner) throw new HttpError(403, "Only the host can choose co-hosts.");
      if (!target || target === ownerIdentity(m)) bad("Pick someone in the meeting.");
      const p = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity: target } } });
      if (!p || p.status !== "admitted") bad("They need to be in the meeting.");
      const coHosts = input.on === false ? m.coHosts.filter((x) => x !== target) : [...new Set([...m.coHosts, target])];
      if (coHosts.length > 10) bad("A meeting can have up to 10 co-hosts.");
      const u = await db.meeting.update({ where: { id: m.id }, data: { coHosts } });
      await setRoleMeta(u, target);
      await syncRoomMeta(u);
      await sendRoom(u, "iotx.host", { type: input.on === false ? "cohost_off" : "cohost", identity: target, name: p.name });
      return { ok: true, coHosts };
    }
    case "spotlight": {
      const u = await db.meeting.update({ where: { id: m.id }, data: { spotlight: target || null } });
      await syncRoomMeta(u);
      return { ok: true, spotlight: u.spotlight };
    }
    case "captions": {
      if (input.on !== false && m.e2ee) throw new HttpError(409, "Captions are off in end-to-end encrypted meetings (they would send what people say to the server).");
      const data: Record<string, unknown> = { captions: input.on !== false };
      if (input.lang) {
        if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(input.lang)) bad("Pick a caption language like en-US.");
        data.captionLang = input.lang;
      }
      const u = await db.meeting.update({ where: { id: m.id }, data });
      await syncRoomMeta(u);
      return { ok: true, captions: u.captions, captionLang: u.captionLang };
    }
    case "lock":
    case "unlock": {
      const u = await db.meeting.update({ where: { id: m.id }, data: { locked: input.action === "lock" } });
      await syncRoomMeta(u);
      return { ok: true, locked: u.locked };
    }
    case "end": {
      if (!c.owner && !c.me) throw new HttpError(403, "Only the host can end the meeting for everyone.");
      const { stopAllRecordings } = await import("./recording");
      await stopAllRecordings(m).catch((e) => console.error("[meet] stop recordings", e));
      const { stopStreams } = await import("./webinar");
      await stopStreams(m).catch((e) => console.error("[meet] stop streams", e));
      const u = await db.meeting.update({ where: { id: m.id }, data: { endedAt: new Date(), spotlight: null, breakout: Prisma.DbNull } });
      const { closeBreakoutRooms, notesFromCaptions } = await import("./extras");
      await closeBreakoutRooms(m).catch(() => null);
      await quiet(() => svc.deleteRoom(room));
      // Captions but no notes recording: write notes from the captions (if the role allows AI notes).
      if (c.me && can(c.me, MEET_KEYS.aiNotes)) void notesFromCaptions(u, false).catch(() => null);
      return { ok: true, ended: true };
    }
    default:
      bad("Unknown control.");
  }
}

/**
 * Someone with host controls leaves (or drops): if nobody with host controls
 * is left in the room, the person who has been there longest becomes a
 * co-host (members before guests), or the one the leaver picked.
 */
export async function handOver(m: Meeting, leaving: string, transferTo?: string) {
  if (!hostLikeIdentity(m, leaving)) return null;
  const list = ((await quiet(() => rooms().listParticipants(roomName(m.id)))) ?? []).filter((p) => p.identity !== leaving);
  if (!list.length) return null;
  if (!transferTo && list.some((p) => hostLikeIdentity(m, p.identity))) return null;
  const pick = transferTo
    ? list.find((p) => p.identity === transferTo)
    : [...list].sort((a, b) => Number(a.identity.startsWith("g_")) - Number(b.identity.startsWith("g_")) || Number(a.joinedAt) - Number(b.joinedAt))[0];
  if (!pick) bad("They aren't in the meeting.");
  const u = await db.meeting.update({ where: { id: m.id }, data: { coHosts: [...new Set([...m.coHosts.filter((x) => x !== leaving || leaving === ownerIdentity(m)), pick.identity])] } });
  await setRoleMeta(u, pick.identity);
  await syncRoomMeta(u);
  await sendRoom(u, "iotx.host", { type: "handover", identity: pick.identity, name: pick.name });
  return { identity: pick.identity, name: pick.name };
}

/** POST /leave: the caller is leaving; hand host controls on if needed. */
export async function leaveMeeting(me: Me | null, m: Meeting, guestKey: string | null, transferTo?: string) {
  const c = await caller(me, m, guestKey);
  if (!c) throw new HttpError(403, "Join the meeting first.");
  if (transferTo && !c.hostLike) throw new HttpError(403, "Only hosts can hand over the meeting.");
  const to = await handOver(m, c.identity, transferTo || undefined);
  return { ok: true, newHost: to };
}

/** Raise or lower a hand (participant attribute, so people who join later see it too). */
export async function setHand(m: Meeting, identity: string, up: boolean) {
  await quiet(() => rooms().updateParticipant(roomName(m.id), identity, { attributes: { hand: up ? String(Date.now()) : "" } }));
  // Webinar attendees are hidden in the room, so hosts read raised hands from here (and get a nudge).
  if (m.kind === "webinar") {
    await db.meetParticipant.updateMany({ where: { meetingId: m.id, identity }, data: { handAt: up ? new Date() : null } });
    await sendRoom(m, "iotx.webinar", { type: up ? "hand" : "hand_down", identity }, [ownerIdentity(m), ...m.coHosts]);
  }
  return { ok: true, up };
}

/** The caller's participant record: a member (session) or a guest (key). */
export async function callerParticipant(me: Me | null, m: Meeting, guestKey?: string | null) {
  if (isMember(me, m) && !guestKey) return db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity: `u_${me.userId}` } } });
  if (guestKey) return db.meetParticipant.findFirst({ where: { meetingId: m.id, kind: "guest", keyHash: hashKey(guestKey) } });
  return null;
}

/** Meetings for the landing page: mine (hosted or invited), newest first. */
export async function myMeetings(me: Me) {
  const ms = await db.meeting.findMany({
    where: { ws: me.ws, personal: false, OR: [{ hostId: me.userId }, { invitees: { has: me.userId } }, { participants: { some: { userId: me.userId } } }] },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return ms.map((m) => ({
    code: m.code, title: m.title, host: m.hostId === me.userId, startedAt: m.startedAt, endedAt: m.endedAt, createdAt: m.createdAt,
    notes: m.notesStatus, eventId: m.eventId,
  }));
}

/**
 * Calendar hook ("Add video meeting"): a meeting for an event being saved.
 * Returns null when the event already has a Meet link.
 */
export async function meetingForEvent(me: Me, req: Request, input: { title?: string; attendees?: { userId?: string }[]; conferenceUrl?: string | null }) {
  if (input.conferenceUrl && /\/workspace\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(input.conferenceUrl)) return null;
  const m = await createMeeting(me, { title: input.title || "Meeting", invitees: (input.attendees ?? []).map((a) => a.userId).filter((x): x is string => !!x) });
  return { id: m.id, code: m.code, url: meetingUrl(req, m.code) };
}
export async function linkEvent(meetingId: string, eventId: string) {
  await db.meeting.update({ where: { id: meetingId }, data: { eventId } });
}

/** The public URL of a meeting, from the request (production is same-origin behind Caddy). */
export function meetingUrl(req: Request, code: string) {
  const fixed = (process.env.WORKSPACE_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (fixed) return `${fixed}/workspace/meet/${code}`;
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3100";
  const proto = h.get("x-forwarded-proto") ?? (/^localhost|^127\./.test(host) ? "http" : "https");
  return `${proto}://${host}/workspace/meet/${code}`;
}
