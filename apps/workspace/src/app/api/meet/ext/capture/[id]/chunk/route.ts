import { route } from "@/lib/http";
import { addChunk, tokenMe } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/** PUT (Bearer) ?seq=N, body = the raw audio chunk (MediaRecorder, ~10 s) -> { ok, seq, chunks, bytes } */
async function PUT_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { me } = await tokenMe(req);
  const seq = new URL(req.url).searchParams.get("seq");
  const buf = Buffer.from(await req.arrayBuffer());
  return Response.json(await addChunk(me, (await ctx.params).id, seq, buf));
}

export const PUT = route(PUT_);
export const POST = route(PUT_);
