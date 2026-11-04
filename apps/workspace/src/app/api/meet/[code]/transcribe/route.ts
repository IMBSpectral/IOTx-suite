import { getMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { transcribeChunk } from "@/lib/meet/live-captions";

export const dynamic = "force-dynamic";

/** POST multipart "file" (a few seconds of my own microphone) -> { text } saved as a caption line. For browsers without speech recognition. */
async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  const form = await req.formData().catch(() => null);
  const f = form?.get("file");
  return Response.json(await transcribeChunk(await getMe(), m, req.headers.get("x-meet-guest"), f instanceof File ? f : null));
}

export const POST = route(POST_);
