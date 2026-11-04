import { getMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { uploadMeetFile } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";

/** POST multipart "file" -> { file } to attach to a chat message. */
async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  const form = await req.formData().catch(() => null);
  const f = form?.get("file");
  if (!(f instanceof File)) return Response.json({ error: "Choose a file." }, { status: 400 });
  return Response.json({ file: await uploadMeetFile(await getMe(), m, req.headers.get("x-meet-guest"), f) }, { status: 201 });
}

export const POST = route(POST_);
