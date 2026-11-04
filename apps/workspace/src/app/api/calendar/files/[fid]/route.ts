import { requireMe } from "@/lib/auth";
import { deleteEventFile, readEventFile } from "@/lib/cal-plus";
import { route } from "@/lib/http";

type Ctx = { params: Promise<{ fid: string }> };
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

/** GET -> the file (sandboxed) · DELETE */
async function GET_(req: Request, ctx: Ctx) {
  const me = await requireMe("calendar.open");
  const { a, data } = await readEventFile(me, (await ctx.params).fid);
  const inline = INLINE.test(a.type) && new URL(req.url).searchParams.get("download") !== "1";
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": INLINE.test(a.type) ? a.type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    },
  });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("calendar.open");
  return Response.json(await deleteEventFile(me, (await ctx.params).fid));
}

export const GET = route(GET_);
export const DELETE = route(DELETE_);
