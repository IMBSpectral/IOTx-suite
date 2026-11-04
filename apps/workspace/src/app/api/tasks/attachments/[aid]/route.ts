import { requireMe } from "@/lib/auth";
import { deleteAttachment, readAttachment } from "@/lib/tasks-plan";
import { route } from "@/lib/http";

type Ctx = { params: Promise<{ aid: string }> };
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|video\/mp4|audio\/(mpeg|mp4|wav))$/;

/** GET -> the file (images, PDFs and plain text open in the browser; others download) · DELETE */
async function GET_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  const { a, data } = await readAttachment(me, (await ctx.params).aid);
  const inline = INLINE.test(a.type) && new URL(req.url).searchParams.get("download") !== "1";
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": INLINE.test(a.type) ? a.type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, max-age=300",
    },
  });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteAttachment(me, (await ctx.params).aid));
}

export const GET = route(GET_);
export const DELETE = route(DELETE_);
