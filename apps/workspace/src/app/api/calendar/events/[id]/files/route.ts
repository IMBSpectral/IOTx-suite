import { requireMe } from "@/lib/auth";
import { addEventFile, listEventFiles } from "@/lib/cal-plus";
import { bad, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { files } · POST multipart (file) -> { file } (25 MB, 20 per event) */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("calendar.open");
  return Response.json({ files: await listEventFiles(me, (await ctx.params).id) });
}
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("calendar.open");
  const f = (await req.formData().catch(() => null))?.get("file");
  if (!(f instanceof File)) bad("Choose a file.");
  return Response.json({ file: await addEventFile(me, (await ctx.params).id, f) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
