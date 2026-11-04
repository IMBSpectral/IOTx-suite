import { requireMe } from "@/lib/auth";
import { bad, body, route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { discardRecorder, finishRecorder, requireReporter, startRecorder, unfinished } from "@/lib/meet/ingest";

export const dynamic = "force-dynamic";

/**
 * In-person recorder.
 * GET  -> { unfinished: [...] } my recordings that were never finished
 * POST { action: "start", title?, mime? }  -> { id, code, next: 0 }
 *      { action: "finish", id, title? }    -> { code } (the report is being written)
 *      { action: "discard", id }
 * Chunks: PUT /api/meet/record/<id>?seq=N (body = the chunk).
 */
async function GET_() {
  const me = requireReporter(await requireMe(MEET_KEYS.open));
  return Response.json({ unfinished: await unfinished(me) });
}

async function POST_(req: Request) {
  const me = await requireMe(MEET_KEYS.open);
  const b = await body<{ action?: string; id?: string; title?: string; mime?: string }>(req);
  if (b.action === "start") return Response.json(await startRecorder(me, b), { status: 201 });
  if (b.action === "finish") return Response.json(await finishRecorder(me, String(b.id ?? ""), b));
  if (b.action === "discard") return Response.json(await discardRecorder(me, String(b.id ?? "")));
  bad("Unknown action.");
}

export const GET = route(GET_);
export const POST = route(POST_);
