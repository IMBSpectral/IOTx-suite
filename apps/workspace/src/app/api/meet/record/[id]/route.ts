import { requireMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { recorderChunk } from "@/lib/meet/ingest";

export const dynamic = "force-dynamic";

/** PUT ?seq=N body = chunk N of the recording -> { ok, next }. 409 { next } when a chunk is missing. */
async function PUT_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(MEET_KEYS.open);
  const seq = Number(new URL(req.url).searchParams.get("seq"));
  return Response.json(await recorderChunk(me, (await ctx.params).id, seq, await req.arrayBuffer()));
}

export const PUT = route(PUT_);
