import fs from "node:fs";
import path from "node:path";
import type { Meeting, MeetRecording } from "@prisma/client";
import { AudioCodec, EgressStatus, EncodedFileOutput, EncodedFileType, EncodingOptions, type EgressInfo } from "livekit-server-sdk";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad } from "../http";
import { egress, roomName } from "./livekit";
import { hostLikeIdentity, isMember, MEET_KEYS, syncRoomMeta } from "./meetings";

/**
 * Recording with LiveKit Egress. "video" is a room-composite MP4 (grid
 * layout); "audio" is an audio-only OGG used for AI notes. Egress writes into
 * its own /out folder, which is this app's storage/meet-recordings folder
 * (a bind mount locally, a shared volume on the server).
 *
 * Only the host, and only with the meetings.record / meetings.ai_notes switch,
 * can start or stop either. Everyone in the room sees the notice: LiveKit
 * marks the room as recording, and the room metadata says which kind.
 */

export const RECORDINGS_DIR = path.resolve(process.env.MEET_RECORDINGS_DIR ?? path.join(process.cwd(), "storage", "meet-recordings"));
const EGRESS_OUT_DIR = (process.env.MEET_EGRESS_OUT_DIR ?? "/out").replace(/\/$/, "");

export type RecKind = "video" | "audio";
const KEY: Record<RecKind, (typeof MEET_KEYS)[keyof typeof MEET_KEYS]> = { video: MEET_KEYS.record, audio: MEET_KEYS.aiNotes };

/** The host, or a co-host who is a member, with the role switch for this kind. */
export function requireRecorder(me: Me | null, m: Meeting, kind: RecKind) {
  if (!isMember(me, m) || !hostLikeIdentity(m, `u_${me.userId}`)) throw new HttpError(403, "Only the host can do that.");
  const host = me;
  if (!can(host, KEY[kind]))
    throw new HttpError(403, kind === "video" ? "Your role can't record meetings." : "Your role can't use AI notes.", { key: KEY[kind] });
  return host;
}

const STATUS: Record<number, string> = {
  [EgressStatus.EGRESS_STARTING]: "starting",
  [EgressStatus.EGRESS_ACTIVE]: "active",
  [EgressStatus.EGRESS_ENDING]: "ending",
  [EgressStatus.EGRESS_COMPLETE]: "complete",
  [EgressStatus.EGRESS_FAILED]: "failed",
  [EgressStatus.EGRESS_ABORTED]: "failed",
  [EgressStatus.EGRESS_LIMIT_REACHED]: "complete",
};

/** Apply what LiveKit says about an egress to our row. */
export async function applyEgressInfo(info: EgressInfo) {
  const rec = await db.meetRecording.findUnique({ where: { egressId: info.egressId } });
  if (!rec) return null;
  const status = STATUS[info.status] ?? rec.status;
  const size = Number(info.fileResults?.[0]?.size ?? 0) || rec.size;
  const ended = ["complete", "failed"].includes(status);
  const upd = await db.meetRecording.update({
    where: { id: rec.id },
    data: { status, size, error: info.error ? String(info.error).slice(0, 500) : rec.error, ...(ended && !rec.endedAt ? { endedAt: new Date() } : {}) },
  });
  if (ended && rec.status !== status) {
    const m = await db.meeting.findUnique({ where: { id: rec.meetingId } });
    if (m) {
      await syncRoomMeta(m).catch(() => null);
      if (rec.kind === "audio" && m.notesStatus === "processing") void processNotes(m.id);
    }
  }
  return upd;
}

/** Ask LiveKit for the latest state of recordings that haven't finished. */
export async function refreshRecordings(m: Meeting) {
  const open = await db.meetRecording.findMany({ where: { meetingId: m.id, status: { in: ["starting", "active", "ending"] } } });
  for (const r of open) {
    try {
      const [info] = await egress().listEgress({ egressId: r.egressId });
      if (info) await applyEgressInfo(info);
    } catch (e) {
      console.error("[meet] egress refresh", (e as Error).message);
    }
  }
}

export async function startRecording(me: Me | null, m: Meeting, kind: RecKind) {
  const host = requireRecorder(me, m, kind);
  if (m.endedAt) bad("This meeting has ended.");
  // The recorder joins like anyone else and has no key: it would only get scrambled media.
  if (m.e2ee) throw new HttpError(409, kind === "video" ? "Recording is off in end-to-end encrypted meetings." : "AI notes are off in end-to-end encrypted meetings.");
  const running = await db.meetRecording.findFirst({ where: { meetingId: m.id, kind, status: { in: ["starting", "active"] } } });
  if (running) return running;
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${m.code}-${kind}-${stamp}.${kind === "video" ? "mp4" : "ogg"}`;
  const output = new EncodedFileOutput({ fileType: kind === "video" ? EncodedFileType.MP4 : EncodedFileType.OGG, filepath: `${EGRESS_OUT_DIR}/${file}` });
  let info: EgressInfo;
  try {
    info =
      kind === "video"
        ? await egress().startRoomCompositeEgress(roomName(m.id), output, { layout: "grid" })
        : await egress().startRoomCompositeEgress(roomName(m.id), output, {
            audioOnly: true,
            // Speech at 32 kbps: about two hours fits the 25 MB transcription limit.
            encodingOptions: new EncodingOptions({ audioCodec: AudioCodec.OPUS, audioBitrate: 32, audioFrequency: 48000 }),
          });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    console.error("[meet] start egress", msg);
    throw new HttpError(503, /no response|unavailable|egress not connected|not connected/i.test(msg) ? "The recorder isn't running on this server." : `The recorder couldn't start: ${msg.slice(0, 200)}`);
  }
  const rec = await db.meetRecording.create({ data: { meetingId: m.id, kind, egressId: info.egressId, file, status: STATUS[info.status] ?? "starting", startedBy: host.userId } });
  if (kind === "audio") await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "recording", notesError: "" } });
  await syncRoomMeta(m);
  return rec;
}

async function stopOne(r: MeetRecording) {
  try {
    const info = await egress().stopEgress(r.egressId);
    await applyEgressInfo(info);
  } catch (e) {
    // Already finished (or the egress is gone): ask for its final state.
    const [info] = await egress().listEgress({ egressId: r.egressId }).catch(() => []);
    if (info) await applyEgressInfo(info);
    else await db.meetRecording.update({ where: { id: r.id }, data: { status: "failed", error: String((e as Error).message).slice(0, 300), endedAt: new Date() } });
  }
}

export async function stopRecording(me: Me | null, m: Meeting, kind: RecKind) {
  requireRecorder(me, m, kind);
  const open = await db.meetRecording.findMany({ where: { meetingId: m.id, kind, status: { in: ["starting", "active"] } } });
  if (kind === "audio") await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "processing" } });
  for (const r of open) await stopOne(r);
  await syncRoomMeta(m);
  if (kind === "audio") void processNotes(m.id);
  return { ok: true, stopped: open.length };
}

/** "End for all" stops every recording; notes are written from what was captured. */
export async function stopAllRecordings(m: Meeting) {
  const open = await db.meetRecording.findMany({ where: { meetingId: m.id, status: { in: ["starting", "active"] } } });
  if (open.some((r) => r.kind === "audio")) await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "processing" } });
  for (const r of open) await stopOne(r);
  if (open.some((r) => r.kind === "audio")) void processNotes(m.id);
}

export function recordingDto(r: MeetRecording) {
  return { id: r.id, kind: r.kind, status: r.deletedAt ? "deleted" : r.status, size: r.size, error: r.error, startedAt: r.startedAt, endedAt: r.endedAt, file: r.file, deletedAt: r.deletedAt };
}

/** Delete a recording's file (the row stays, marked deleted). */
export async function deleteRecording(r: MeetRecording) {
  try {
    fs.rmSync(recordingPath(r), { force: true });
  } catch {}
  return db.meetRecording.update({ where: { id: r.id }, data: { deletedAt: new Date() } });
}

/**
 * Retention: recordings older than MEET_RECORDING_DAYS (default 90) are
 * deleted, and each workspace keeps at most MEET_RECORDINGS_MAX_MB (default
 * 20 GB), oldest first.
 */
export async function retentionTick(now = new Date()) {
  const days = Number(process.env.MEET_RECORDING_DAYS ?? 90) || 90;
  const capBytes = (Number(process.env.MEET_RECORDINGS_MAX_MB ?? 20480) || 20480) * 1024 * 1024;
  let deleted = 0;
  const old = await db.meetRecording.findMany({ where: { deletedAt: null, status: { in: ["complete", "failed"] }, startedAt: { lt: new Date(now.getTime() - days * 86400_000) } } });
  for (const r of old) {
    await deleteRecording(r);
    deleted++;
  }
  const live = await db.meetRecording.findMany({ where: { deletedAt: null, status: "complete" }, include: { meeting: { select: { ws: true } } }, orderBy: { startedAt: "desc" } });
  const used = new Map<string, number>();
  for (const r of live) {
    const total = (used.get(r.meeting.ws) ?? 0) + r.size;
    used.set(r.meeting.ws, total);
    if (total > capBytes) {
      await deleteRecording(r);
      deleted++;
    }
  }
  return deleted;
}

/** A finished recording's file on disk (path checked to stay in the folder). */
export function recordingPath(r: MeetRecording) {
  const p = path.resolve(RECORDINGS_DIR, path.basename(r.file));
  if (!p.startsWith(RECORDINGS_DIR)) throw new HttpError(404, "Not found");
  return p;
}

// AI notes live in ./notes (imported lazily to keep this module light).
async function processNotes(meetingId: string) {
  const { generateNotes } = await import("./notes");
  await generateNotes(meetingId).catch((e) => console.error("[meet] notes", e));
}
