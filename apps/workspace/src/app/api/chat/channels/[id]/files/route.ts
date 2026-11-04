import { requireMe } from "@/lib/auth";
import { listFiles, uploadFile } from "@/lib/chat";
import { route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST multipart "file" -> { file } (attach it by sending a message with fileIds) · GET -> { files } in this channel */
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  const form = await req.formData().catch(() => null);
  const f = form?.get("file");
  if (!(f instanceof File)) return Response.json({ error: "Choose a file." }, { status: 400 });
  return Response.json({ file: await uploadFile(me, (await ctx.params).id, f) }, { status: 201 });
}
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json({ files: await listFiles(me, { channelId: (await ctx.params).id }) });
}

export const POST = route(POST_);
export const GET = route(GET_);
