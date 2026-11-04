import { requireMe } from "@/lib/auth";
import { discardFile, readFile } from "@/lib/chat";
import { route } from "@/lib/http";

type Ctx = { params: Promise<{ fid: string }> };
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|audio\/(webm|ogg|mpeg|mp4|wav)|video\/(mp4|webm))$/;

/** GET -> the file (sandboxed; ?download=1 to save) · DELETE an upload that wasn't sent */
async function GET_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  const { f, data } = await readFile(me, (await ctx.params).fid);
  const type = f.type.split(";")[0].trim();
  const inline = INLINE.test(type) && new URL(req.url).searchParams.get("download") !== "1";
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": INLINE.test(type) ? type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, max-age=3600",
    },
  });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json(await discardFile(me, (await ctx.params).fid));
}

export const GET = route(GET_);
export const DELETE = route(DELETE_);
