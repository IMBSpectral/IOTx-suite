import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad } from "../http";
import { MEET_KEYS, newCode } from "./meetings";
import { RECORDINGS_DIR } from "./recording";
import { attachMedia, ingestAudio, isVideoMime, MEDIA_EXT, remux } from "./report";

/**
 * Ways into a report besides a live Meet call:
 *   - Upload: an audio or video file (up to 2 GB) streamed to disk, never
 *     held in memory, becomes a kind "upload" meeting.
 *   - In-person recorder: the browser sends 10-second chunks as it records
 *     (MediaRecorder timeslices of one stream, appended in order), so a dead
 *     tab loses at most the last chunk; "finish" makes a kind "inperson"
 *     meeting's report.
 * Both keep the original file as the meeting's playable recording.
 */

export const MAX_UPLOAD_BYTES = Number(process.env.MEET_UPLOAD_MAX_BYTES) || 2 * 1024 ** 3;
const MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const TMP_DIR = path.resolve(RECORDINGS_DIR, "..", "meet-tmp");

export function requireReporter(me: Me) {
  if (!can(me, MEET_KEYS.create)) throw new HttpError(403, "Your role can't add meetings.", { key: MEET_KEYS.create });
  if (!can(me, MEET_KEYS.aiNotes)) throw new HttpError(403, "Your role can't use AI notes.", { key: MEET_KEYS.aiNotes });
  return me;
}

const cleanMime = (v: string | null) => String(v ?? "").split(";")[0].trim().toLowerCase();

async function newReportMeeting(me: Me, input: { title: string; kind: "upload" | "inperson"; startedAt: Date; status: string }) {
  for (let i = 0; i < 5; i++) {
    try {
      return await db.meeting.create({
        data: {
          ws: me.ws, code: newCode(), title: input.title, hostId: me.userId, kind: input.kind, startedAt: input.startedAt, endedAt: input.kind === "upload" ? input.startedAt : null,
          notesStatus: input.status, waitingRoom: true, allowGuests: false,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  throw new HttpError(500, "Couldn't create a meeting code. Try again.");
}

function cleanTitle(v: unknown, fallback: string) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || fallback;
}
function cleanDate(v: unknown) {
  if (!v) return new Date();
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) bad("Pick a valid date.");
  return d;
}

/** POST body = the file itself (content-type = its type); title, date and name in the query. */
export async function saveUpload(me: Me, req: Request) {
  requireReporter(me);
  const q = new URL(req.url).searchParams;
  let mime = cleanMime(req.headers.get("content-type"));
  const name = String(q.get("name") ?? "");
  if (!/^(audio|video)\//.test(mime)) {
    // Some browsers send files with no type: go by the name.
    const ext = path.extname(name).slice(1).toLowerCase();
    const hit = Object.entries(MEDIA_EXT).find(([, e]) => e === ext);
    if (!hit) throw new HttpError(415, "Upload an audio or video file (MP3, M4A, WAV, OGG, WebM, MP4, MOV…).");
    mime = hit[0];
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files can be up to 2 GB.");
  if (!req.body) bad("The file is empty.");
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmp = path.join(TMP_DIR, `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${MEDIA_EXT[mime] ?? "bin"}`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) cb(new HttpError(413, "Files can be up to 2 GB."));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as import("node:stream/web").ReadableStream), limit, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "The upload was interrupted.");
  }
  if (bytes < 1000) {
    fs.rmSync(tmp, { force: true });
    bad("The file is empty.");
  }
  const title = cleanTitle(q.get("title"), name.replace(/\.[^.]+$/, "") || "Uploaded recording");
  const m = await newReportMeeting(me, { title, kind: "upload", startedAt: cleanDate(q.get("date")), status: "processing" });
  const rec = await attachMedia(m.id, tmp, { mime, move: true, startedBy: me.userId });
  void ingestAudio(m.id, path.join(RECORDINGS_DIR, rec.file), { mime, speakers: [] }).catch(() => null);
  return { code: m.code, id: m.id, bytes, video: isVideoMime(mime) };
}

// ── In-person recorder ─────────────────────────────────────────────────────

async function myUpload(me: Me, id: string) {
  const u = await db.meetUpload.findUnique({ where: { id: String(id ?? "") } });
  if (!u || u.ws !== me.ws || u.userId !== me.userId) throw new HttpError(404, "Not found");
  return u;
}
const uploadPath = (file: string) => path.join(RECORDINGS_DIR, path.basename(file));

export async function startRecorder(me: Me, input: { title?: string; mime?: string }) {
  requireReporter(me);
  const mime = cleanMime(input.mime ?? "audio/webm") || "audio/webm";
  if (!/^(audio|video)\//.test(mime)) bad("Unsupported recording type.");
  const ext = MEDIA_EXT[mime] ?? "webm";
  const title = cleanTitle(input.title, `In-person meeting, ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
  const m = await newReportMeeting(me, { title, kind: "inperson", startedAt: new Date(), status: "recording" });
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${m.code}-upload-${isVideoMime(mime) ? "video" : "audio"}-${stamp}.${ext}`;
  fs.writeFileSync(uploadPath(file), new Uint8Array(0));
  const u = await db.meetUpload.create({ data: { ws: me.ws, userId: me.userId, meetingId: m.id, mime, file } });
  return { id: u.id, code: m.code, next: 0 };
}

/** Append chunk number seq. Repeats are ignored; a gap answers 409 with the chunk expected next. */
export async function recorderChunk(me: Me, id: string, seq: number, body: ArrayBuffer) {
  const u = await myUpload(me, id);
  if (u.status !== "recording") throw new HttpError(409, "This recording is finished.");
  if (!Number.isInteger(seq) || seq < 0) bad("Missing chunk number.");
  if (seq < u.chunks) return { ok: true, next: u.chunks, duplicate: true };
  if (seq > u.chunks) throw new HttpError(409, "A chunk is missing.", { next: u.chunks });
  if (body.byteLength > MAX_CHUNK_BYTES) throw new HttpError(413, "That chunk is too large.");
  if (u.bytes + body.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, "Recordings can be up to 2 GB.");
  // Claim the slot first so two copies of the same chunk can't both be written.
  const claim = await db.meetUpload.updateMany({ where: { id: u.id, chunks: seq, status: "recording" }, data: { chunks: seq + 1, bytes: { increment: body.byteLength } } });
  if (!claim.count) return { ok: true, next: seq + 1, duplicate: true };
  fs.appendFileSync(uploadPath(u.file), new Uint8Array(body));
  return { ok: true, next: seq + 1 };
}

export async function finishRecorder(me: Me, id: string, input: { title?: string } = {}) {
  const u = await myUpload(me, id);
  const m = await db.meeting.findUniqueOrThrow({ where: { id: u.meetingId } });
  if (u.status !== "recording") return { code: m.code, already: true };
  const p = uploadPath(u.file);
  const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
  if (size < 1000) {
    await discardRecorder(me, id);
    bad("Nothing was recorded.");
  }
  const claim = await db.meetUpload.updateMany({ where: { id: u.id, status: "recording" }, data: { status: "done", endedAt: new Date() } });
  if (!claim.count) return { code: m.code, already: true };
  // Browser recordings have no duration or seek index until rewritten.
  await remux(p).catch(() => false);
  const now = new Date();
  await db.meeting.update({ where: { id: m.id }, data: { endedAt: now, notesStatus: "processing", ...(input.title ? { title: cleanTitle(input.title, m.title) } : {}) } });
  await db.meetRecording.create({
    data: { meetingId: m.id, kind: "upload", egressId: `upload_${m.id}_rec`, file: u.file, status: "complete", size: Math.min(2 ** 31 - 1, fs.statSync(p).size), startedBy: me.userId, startedAt: m.startedAt ?? u.createdAt, endedAt: now },
  });
  void ingestAudio(m.id, p, { mime: u.mime, speakers: [] }).catch(() => null);
  return { code: m.code };
}

export async function discardRecorder(me: Me, id: string) {
  const u = await myUpload(me, id);
  if (u.status !== "recording") bad("This recording is already finished.");
  fs.rmSync(uploadPath(u.file), { force: true });
  await db.meetUpload.delete({ where: { id: u.id } });
  await db.meeting.delete({ where: { id: u.meetingId } }).catch(() => null);
  return { ok: true };
}

/** My recordings that were never finished (the tab closed or the phone died). */
export async function unfinished(me: Me) {
  const us = await db.meetUpload.findMany({ where: { ws: me.ws, userId: me.userId, status: "recording" }, orderBy: { createdAt: "desc" }, take: 20 });
  const ms = await db.meeting.findMany({ where: { id: { in: us.map((u) => u.meetingId) } }, select: { id: true, title: true, code: true } });
  return us.map((u) => ({ id: u.id, code: ms.find((m) => m.id === u.meetingId)?.code ?? "", title: ms.find((m) => m.id === u.meetingId)?.title ?? "", chunks: u.chunks, bytes: u.bytes, startedAt: u.createdAt }));
}
