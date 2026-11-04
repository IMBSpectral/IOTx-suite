import { db } from "@/lib/db";
import { getMe } from "@/lib/auth";
import { bad, body, route } from "@/lib/http";
import { byCode, requireHostLike } from "@/lib/meet/meetings";
import { recordingDto, refreshRecordings, startRecording, stopRecording, type RecKind } from "@/lib/meet/recording";

export const dynamic = "force-dynamic";

/**
 * GET  -> { recordings } (host)
 * POST { kind: "video" | "audio", action: "start" | "stop" } (host with meetings.record / meetings.ai_notes)
 * "audio" is the AI-notes recording.
 */
async function GET_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  await requireHostLike(await getMe(), m, req.headers.get("x-meet-guest"));
  await refreshRecordings(m);
  const recs = await db.meetRecording.findMany({ where: { meetingId: m.id }, orderBy: { startedAt: "desc" } });
  return Response.json({ recordings: recs.map(recordingDto) });
}

async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ kind?: string; action?: string }>(req);
  const kind: RecKind = b.kind === "audio" ? "audio" : b.kind === "video" ? "video" : bad("kind must be video or audio");
  const me = await getMe();
  if (b.action === "start") return Response.json({ recording: recordingDto(await startRecording(me, m, kind)) });
  if (b.action === "stop") return Response.json(await stopRecording(me, m, kind));
  bad("action must be start or stop");
}

export const GET = route(GET_);
export const POST = route(POST_);
