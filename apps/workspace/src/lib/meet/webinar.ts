import crypto from "node:crypto";
import type { Meeting, MeetStream } from "@prisma/client";
import { EgressStatus, StreamOutput, StreamProtocol, type EgressInfo } from "livekit-server-sdk";
import { db } from "../db";
import { HttpError, type Me } from "../auth";
import { bad } from "../http";
import { notify } from "../notify";
import { EMAIL_ORIGIN, BASE } from "../env";
import { egress, joinToken, quiet, roomName, rooms } from "./livekit";
import {
  ensureRoom, hashKey, hostLikeIdentity, ipHashFor, limited, markStarted, requireHostLike, roleFor, sendRoom, setRoleMeta, syncRoomMeta, tokenReply, WEBINAR_CAP,
} from "./meetings";
import { requireRecorder } from "./recording";
import { dialInText } from "./sip";

/**
 * Webinars: the host, co-hosts and panelists are on stage; attendees watch
 * (their LiveKit token can't publish and hides them). Attendees raise a hand
 * to be brought on stage, ask in Q&A and answer polls.
 *
 * Registration (optional): a public form at /meet/<code>/register. Each
 * registrant gets their own join link by email (the suite mail route, the
 * same one Calendar uses); with approval on, a host approves them first.
 * Links carry a secret stored here only as a hash; sending a link again makes
 * a new one.
 *
 * Live streaming to an RTMP address (YouTube, Facebook, a CDN) uses LiveKit
 * Egress, like recordings. MEET_STREAMING=off turns it off.
 */

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/;
const newToken = () => crypto.randomBytes(24).toString("base64url");
export const joinLink = (m: Meeting, token: string) => `${EMAIL_ORIGIN}${BASE}/meet/${m.code}?r=${encodeURIComponent(token)}`;
export const registerLink = (m: Meeting) => `${EMAIL_ORIGIN}${BASE}/meet/${m.code}/register`;

function requireWebinar(m: Meeting) {
  if (m.kind !== "webinar") bad("This isn't a webinar.");
}

const whenText = (d: Date | null) =>
  d ? d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }) : "";

// ── Registration ───────────────────────────────────────────────────────────

/** What the public registration page shows. */
export async function registrationInfo(m: Meeting) {
  requireWebinar(m);
  const host = await db.user.findUnique({ where: { id: m.hostId } });
  return {
    code: m.code,
    title: m.title,
    host: host?.name ?? host?.email ?? "The host",
    startsAt: m.startsAt,
    open: m.registration && !m.endedAt,
    approval: m.regApproval,
  };
}

async function mailLink(m: Meeting, r: { id: string; email: string; name: string }) {
  const token = newToken();
  await db.meetRegistrant.update({ where: { id: r.id }, data: { tokenHash: hashKey(token), emailedAt: new Date() } });
  const { sendMail } = await import("../cal-mail");
  const link = joinLink(m, token);
  const dial = dialInText(m);
  const text = [
    `Hi ${r.name},`,
    "",
    `You're registered for "${m.title}".`,
    ...(m.startsAt ? [`When: ${whenText(m.startsAt)}`] : []),
    "",
    "Your personal join link (don't share it; it's only for you):",
    link,
    ...(dial ? ["", dial] : []),
  ].join("\n");
  const ok = await sendMail({ to: r.email, subject: `Your link for ${m.title}`, text, fromName: "IOTx Webinars" });
  return { ok, link };
}

/** POST /register (public): sign up for a webinar. */
export async function register(m: Meeting, input: { name?: string; email?: string; company?: string }, ip = "local") {
  requireWebinar(m);
  if (!m.registration) bad("This webinar doesn't take registrations.");
  if (m.endedAt) bad("This webinar has ended.");
  if (limited(`reg:${m.id}:${ip}`, 6, 10 * 60_000)) throw new HttpError(429, "Too many registrations from here. Try again in a few minutes.");
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(input.email ?? "").trim().toLowerCase().slice(0, 200);
  const company = String(input.company ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) bad("Enter your name.");
  if (!EMAIL_RE.test(email)) bad("Enter a valid email address.");
  if ((await db.meetRegistrant.count({ where: { meetingId: m.id } })) >= WEBINAR_CAP * 3) bad("Registration is full.");
  const existing = await db.meetRegistrant.findUnique({ where: { meetingId_email: { meetingId: m.id, email } } });
  if (existing) {
    // Same email again: send the link again (approved), or say it's waiting. Nothing else is revealed.
    if (existing.status === "approved") await mailLink(m, existing);
    return { ok: true, status: existing.status === "denied" ? "pending" : existing.status };
  }
  const status = m.regApproval ? "pending" : "approved";
  const r = await db.meetRegistrant.create({ data: { meetingId: m.id, email, name, company, status, tokenHash: hashKey(newToken()), ipHash: ipHashFor(m, ip) } });
  if (status === "approved") await mailLink(m, r);
  else {
    const { sendMail } = await import("../cal-mail");
    await sendMail({ to: email, subject: `Registration received: ${m.title}`, text: `Hi ${name},\n\nThanks for registering for "${m.title}". The host will review it, and you'll get your join link by email once you're approved.`, fromName: "IOTx Webinars" });
    await notify({ ws: m.ws, userId: m.hostId, kind: "meet.registration", title: `${name} registered for ${m.title}`, body: "Approve or decline them in the webinar.", link: `/meet/${m.code}`, key: `meet-reg:${r.id}` });
  }
  return { ok: true, status };
}

export async function listRegistrants(me: Me | null, m: Meeting, guestKey?: string | null) {
  requireWebinar(m);
  await requireHostLike(me, m, guestKey);
  const rs = await db.meetRegistrant.findMany({ where: { meetingId: m.id }, orderBy: { createdAt: "asc" }, take: 5000 });
  return rs.map((r) => ({ id: r.id, name: r.name, email: r.email, company: r.company, status: r.status, emailedAt: r.emailedAt, joinedAt: r.joinedAt, at: r.createdAt }));
}

export async function registrantAction(me: Me | null, m: Meeting, guestKey: string | null, b: { action?: string; id?: string; ids?: string[] }) {
  requireWebinar(m);
  await requireHostLike(me, m, guestKey);
  const ids = [...new Set([...(b.ids ?? []), ...(b.id ? [b.id] : [])].map(String))].slice(0, 500);
  if (!ids.length) bad("Pick someone.");
  const rs = await db.meetRegistrant.findMany({ where: { meetingId: m.id, id: { in: ids } } });
  if (!rs.length) throw new HttpError(404, "Registrant not found");
  let emailed = 0;
  for (const r of rs) {
    if (b.action === "approve" || b.action === "resend") {
      if (b.action === "resend" && r.status !== "approved") continue;
      await db.meetRegistrant.update({ where: { id: r.id }, data: { status: "approved" } });
      if ((await mailLink(m, r)).ok) emailed++;
    } else if (b.action === "deny") {
      // A new random hash: any link they had stops working.
      await db.meetRegistrant.update({ where: { id: r.id }, data: { status: "denied", tokenHash: hashKey(newToken()) } });
      if (r.identity) await quiet(() => rooms().removeParticipant(roomName(m.id), r.identity!));
    } else if (b.action === "remove") {
      await db.meetRegistrant.delete({ where: { id: r.id } });
    } else bad("Unknown action.");
  }
  return { ok: true, count: rs.length, emailed };
}

/** Join with a registrant's emailed link: always the same identity, so one link is one seat. */
export async function joinRegistrant(m: Meeting, token: string, ip: string) {
  if (limited(`regjoin:${m.id}:${ip}`, 20, 60_000)) throw new HttpError(429, "Too many requests to join. Wait a minute and try again.");
  const r = await db.meetRegistrant.findFirst({ where: { meetingId: m.id, tokenHash: hashKey(token) } });
  if (!r) throw new HttpError(403, "That join link isn't valid any more. Use the latest email, or register again.", { status: "register" });
  if (r.status === "pending") throw new HttpError(403, "Your registration is waiting for the host's approval.", { status: "pending" });
  if (r.status !== "approved") throw new HttpError(403, "The host declined this registration.", { status: "denied" });
  if (m.locked) throw new HttpError(423, "The host has locked this webinar.", { status: "locked" });
  if (m.endedAt) return { status: "waiting" as const, participantId: r.id, ended: true };
  const identity = `g_r${r.id}`;
  const prev = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity } } });
  if (prev?.status === "removed") throw new HttpError(403, "The host removed you from this webinar.", { status: "removed" });
  const key = crypto.randomBytes(24).toString("base64url");
  const role = roleFor(m, identity, "guest");
  const p = await db.meetParticipant.upsert({
    where: { meetingId_identity: { meetingId: m.id, identity } },
    create: { meetingId: m.id, kind: "guest", name: r.name, identity, role, status: "admitted", keyHash: hashKey(key), ipHash: ipHashFor(m, ip), registrantId: r.id, decidedBy: "registration", decidedAt: new Date(), joinedAt: new Date() },
    update: { keyHash: hashKey(key), name: r.name, role, status: "admitted", joinedAt: new Date() },
  });
  await db.meetRegistrant.update({ where: { id: r.id }, data: { identity, joinedAt: r.joinedAt ?? new Date() } });
  const started = await markStarted(await ensureRoom(m), { name: r.name });
  await syncRoomMeta(started);
  return { ...tokenReply(started, p, await joinToken({ room: roomName(m.id), identity, name: r.name, role }), role), key };
}

// ── The audience and the stage ─────────────────────────────────────────────

/** Hosts: who is watching now, raised hands first. */
export async function attendees(me: Me | null, m: Meeting, guestKey?: string | null) {
  requireWebinar(m);
  await requireHostLike(me, m, guestKey);
  const live = ((await quiet(() => rooms().listParticipants(roomName(m.id)))) ?? []).map((p) => p.identity);
  const here = new Set(live);
  const ps = await db.meetParticipant.findMany({ where: { meetingId: m.id, status: "admitted", identity: { in: live } } });
  const list = ps
    .filter((p) => !hostLikeIdentity(m, p.identity))
    .map((p) => ({ identity: p.identity, name: p.name, kind: p.kind, role: roleFor(m, p.identity, "guest"), hand: p.handAt, registered: !!p.registrantId }))
    .sort((a, b) => Number(!a.hand) - Number(!b.hand) || (a.hand && b.hand ? +a.hand - +b.hand : 0) || a.name.localeCompare(b.name));
  return { attendees: list.filter((x) => x.role === "attendee"), stage: list.filter((x) => x.role === "panelist"), count: here.size, cap: WEBINAR_CAP };
}

/** Bring someone on stage (they may publish) or back to the audience. */
export async function setStage(me: Me | null, m: Meeting, guestKey: string | null, b: { identity?: string; on?: boolean }) {
  requireWebinar(m);
  await requireHostLike(me, m, guestKey);
  const identity = String(b.identity ?? "");
  const p = await db.meetParticipant.findUnique({ where: { meetingId_identity: { meetingId: m.id, identity } } });
  if (!p || p.status !== "admitted") bad("They need to be in the webinar.");
  if (hostLikeIdentity(m, identity)) bad("Hosts are always on stage.");
  const on = b.on !== false;
  // Panelists invited by the host stay on stage; "off" moves everyone else back.
  const stage = on ? [...new Set([...m.stage, identity])] : m.stage.filter((x) => x !== identity);
  if (stage.length > 50) bad("Up to 50 people can be on stage.");
  const u = await db.meeting.update({ where: { id: m.id }, data: { stage, ...(!on && p.userId ? { panelists: m.panelists.filter((x) => x !== p.userId) } : {}) } });
  await db.meetParticipant.update({ where: { id: p.id }, data: { handAt: null } });
  await quiet(() => rooms().updateParticipant(roomName(m.id), identity, { attributes: { hand: "" } }));
  await setRoleMeta(u, identity);
  await syncRoomMeta(u);
  await sendRoom(u, "iotx.webinar", { type: on ? "stage" : "audience", identity, name: p.name });
  return { ok: true, role: roleFor(u, identity, "guest") };
}

// ── Live streaming (RTMP through LiveKit Egress) ───────────────────────────

const STATUS: Record<number, string> = {
  [EgressStatus.EGRESS_STARTING]: "starting",
  [EgressStatus.EGRESS_ACTIVE]: "active",
  [EgressStatus.EGRESS_ENDING]: "ending",
  [EgressStatus.EGRESS_COMPLETE]: "complete",
  [EgressStatus.EGRESS_FAILED]: "failed",
  [EgressStatus.EGRESS_ABORTED]: "failed",
  [EgressStatus.EGRESS_LIMIT_REACHED]: "complete",
};
export const streamingEnabled = () => !/^(off|0|false)$/i.test(process.env.MEET_STREAMING ?? "");

/** The address without the stream key (what we store and show). */
export function maskTarget(url: string) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const shown = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}/••••` : parts.length ? "/••••" : "";
    return `${u.protocol}//${u.host}${shown}`;
  } catch {
    return "rtmp://••••";
  }
}
const streamDto = (s: MeetStream) => ({ id: s.id, target: s.target, status: s.status, error: s.error, startedAt: s.startedAt, endedAt: s.endedAt });

export async function applyStreamInfo(info: EgressInfo) {
  const s = await db.meetStream.findUnique({ where: { egressId: info.egressId } });
  if (!s) return null;
  const status = STATUS[info.status] ?? s.status;
  const ended = ["complete", "failed"].includes(status);
  const err = info.error || info.streamResults?.find((r) => r.error)?.error || "";
  const u = await db.meetStream.update({ where: { id: s.id }, data: { status, error: err ? String(err).slice(0, 500) : s.error, ...(ended && !s.endedAt ? { endedAt: new Date() } : {}) } });
  if (status !== s.status) {
    const m = await db.meeting.findUnique({ where: { id: s.meetingId } });
    if (m) await syncRoomMeta(m).catch(() => null);
  }
  return u;
}

export async function refreshStreams(m: Meeting) {
  const open = await db.meetStream.findMany({ where: { meetingId: m.id, status: { in: ["starting", "active", "ending"] } } });
  for (const s of open) {
    try {
      const [info] = await egress().listEgress({ egressId: s.egressId });
      if (info) await applyStreamInfo(info);
    } catch (e) {
      console.error("[meet] stream refresh", (e as Error).message);
    }
  }
}

export async function streams(me: Me | null, m: Meeting) {
  requireRecorder(me, m, "video");
  await refreshStreams(m);
  const rows = await db.meetStream.findMany({ where: { meetingId: m.id }, orderBy: { startedAt: "desc" }, take: 20 });
  return { enabled: streamingEnabled() && !m.e2ee, streams: rows.map(streamDto) };
}

export async function startStream(me: Me | null, m: Meeting, b: { url?: string; key?: string; layout?: string }) {
  const host = requireRecorder(me, m, "video");
  if (!streamingEnabled()) throw new HttpError(503, "Live streaming is turned off on this server (MEET_STREAMING).");
  if (m.e2ee) throw new HttpError(409, "Live streaming is off in end-to-end encrypted meetings.");
  if (m.endedAt) bad("This meeting has ended.");
  const base = String(b.url ?? "").trim();
  if (!/^rtmps?:\/\/[^\s/]+\/\S*$/i.test(base) || base.length > 500) bad("Enter an RTMP address like rtmp://a.rtmp.youtube.com/live2.");
  const streamKey = String(b.key ?? "").trim();
  if (streamKey.length > 300 || /\s/.test(streamKey)) bad("That stream key doesn't look right.");
  const url = streamKey ? `${base.replace(/\/+$/, "")}/${streamKey}` : base;
  if ((await db.meetStream.count({ where: { meetingId: m.id, status: { in: ["starting", "active"] } } })) >= 3) bad("Up to 3 live streams can run at once.");
  let info: EgressInfo;
  try {
    info = await egress().startRoomCompositeEgress(roomName(m.id), new StreamOutput({ protocol: StreamProtocol.RTMP, urls: [url] }), { layout: b.layout === "grid" ? "grid" : "speaker" });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    console.error("[meet] start stream", msg.replace(url, maskTarget(url)));
    throw new HttpError(503, /no response|unavailable|egress not connected|not connected/i.test(msg) ? "The streaming service (LiveKit Egress) isn't running on this server." : "The live stream couldn't start.");
  }
  const s = await db.meetStream.create({ data: { meetingId: m.id, egressId: info.egressId, target: maskTarget(url), status: STATUS[info.status] ?? "starting", startedBy: host.userId } });
  await syncRoomMeta(m);
  return streamDto(s);
}

export async function stopStream(me: Me | null, m: Meeting, id?: string) {
  requireRecorder(me, m, "video");
  const rows = await db.meetStream.findMany({ where: { meetingId: m.id, status: { in: ["starting", "active"] }, ...(id ? { id } : {}) } });
  for (const s of rows) await stopOne(s);
  await syncRoomMeta(await db.meeting.findUniqueOrThrow({ where: { id: m.id } }));
  return { ok: true, stopped: rows.length };
}

async function stopOne(s: MeetStream) {
  try {
    await applyStreamInfo(await egress().stopEgress(s.egressId));
  } catch (e) {
    const [info] = await egress().listEgress({ egressId: s.egressId }).catch(() => []);
    if (info) await applyStreamInfo(info);
    else await db.meetStream.update({ where: { id: s.id }, data: { status: "failed", error: String((e as Error).message).slice(0, 300), endedAt: new Date() } });
  }
}

/** "End for all": stop every live stream. */
export async function stopStreams(m: Meeting) {
  const rows = await db.meetStream.findMany({ where: { meetingId: m.id, status: { in: ["starting", "active"] } } });
  for (const s of rows) await stopOne(s);
}
