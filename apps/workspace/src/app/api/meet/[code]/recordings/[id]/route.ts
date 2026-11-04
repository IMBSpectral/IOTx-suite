import fs from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getMe, HttpError } from "@/lib/auth";
import { route } from "@/lib/http";
import { byCode, hostLikeIdentity, isMember } from "@/lib/meet/meetings";
import { canSeeHistory } from "@/lib/meet/extras";
import { canSeeReport } from "@/lib/meet/read";
import { deleteRecording, recordingPath } from "@/lib/meet/recording";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string; id: string }> };

/** Egress files are .mp4 (video) and .ogg (notes audio); uploads and in-person recordings keep their own type. */
const TYPES: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", mpeg: "video/mpeg", ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" };
function mediaType(file: string) {
  const ext = file.split(".").pop()!.toLowerCase();
  if (ext === "webm") return /-upload-video-/.test(file) ? "video/webm" : "audio/webm";
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * GET -> the recording, playable in the browser (Range requests for seeking);
 * ?download=1 saves it. For the host, invitees and members who joined.
 * DELETE -> remove the file (hosts).
 */
async function GET_(req: Request, ctx: Ctx) {
  const { code, id } = await ctx.params;
  const m = await byCode(code);
  const me = await getMe();
  // People the report was shared with (or who see it through a folder) can play it too.
  if (!(await canSeeHistory(me, m)) && !(await canSeeReport(me, m))) throw new HttpError(404, "Not found");
  const r = await db.meetRecording.findUnique({ where: { id } });
  if (!r || r.meetingId !== m.id || r.status !== "complete" || r.deletedAt) throw new HttpError(404, "Not found");
  const p = recordingPath(r);
  if (!fs.existsSync(p)) throw new HttpError(404, "The file isn't on this server.");
  const size = fs.statSync(p).size;
  const type = mediaType(r.file);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const base = {
    "content-type": type,
    "accept-ranges": "bytes",
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${r.file}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && !download) {
    let start = range[1] ? Number(range[1]) : NaN;
    let end = range[2] ? Number(range[2]) : size - 1;
    if (Number.isNaN(start)) {
      start = Math.max(0, size - end);
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })) as ReadableStream, {
      status: 206,
      headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(p)) as ReadableStream, { headers: { ...base, "content-length": String(size) } });
}

async function DELETE_(_req: Request, ctx: Ctx) {
  const { code, id } = await ctx.params;
  const me = await getMe();
  const m = await byCode(code);
  if (!isMember(me, m) || !hostLikeIdentity(m, `u_${me.userId}`)) throw new HttpError(403, "Only hosts can delete recordings.");
  const r = await db.meetRecording.findUnique({ where: { id } });
  if (!r || r.meetingId !== m.id) throw new HttpError(404, "Not found");
  if (["starting", "active", "ending"].includes(r.status)) throw new HttpError(409, "Stop the recording first.");
  await deleteRecording(r);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const DELETE = route(DELETE_);
