import { getMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { readMeetFile } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

/** GET -> a chat file (sandboxed). Guests send their key as ?k= since links can't carry headers. */
async function GET_(req: Request, ctx: { params: Promise<{ code: string; fid: string }> }) {
  const { code, fid } = await ctx.params;
  const m = await byCode(code);
  const u = new URL(req.url);
  const { f, data } = await readMeetFile(await getMe(), m, req.headers.get("x-meet-guest") || u.searchParams.get("k"), fid);
  const inline = INLINE.test(f.type) && u.searchParams.get("download") !== "1";
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": INLINE.test(f.type) ? f.type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    },
  });
}

export const GET = route(GET_);
