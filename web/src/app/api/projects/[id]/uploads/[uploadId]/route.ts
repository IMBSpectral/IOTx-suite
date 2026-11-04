import { requireUser, requireProject } from "@/lib/workspace";
import { readUpload } from "@/lib/uploads";
import { route } from "@/lib/route";

/** Media that is safe to play inline: it can't run script on the editor's origin. */
const INLINE_MEDIA = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
]);

/** Serve an attachment back: thumbnails, inline video/audio (with seeking), downloads. */
async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string; uploadId: string }> },
) {
  const { id, uploadId } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const u = await readUpload(id, uploadId);
  if (!u) return new Response("Not found", { status: 404 });
  const inlineImage = u.meta.type.startsWith("image/") && u.meta.type !== "image/svg+xml";
  const media = INLINE_MEDIA.has(u.meta.type);
  const inline = inlineImage || media;
  const headers: Record<string, string> = {
    // Never let an uploaded HTML or SVG file run on the editor's origin.
    "content-type": inline ? u.meta.type : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${u.meta.name.replace(/"/g, "")}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "accept-ranges": media ? "bytes" : "none",
  };

  // Video players fetch byte ranges to seek and to read the duration.
  const range = media ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "") : null;
  if (range) {
    const size = u.bytes.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(new Uint8Array(u.bytes.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(new Uint8Array(u.bytes), { headers });
}

export const GET = route(GET_);
