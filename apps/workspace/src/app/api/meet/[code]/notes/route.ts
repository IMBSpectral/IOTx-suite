import { getMe, HttpError } from "@/lib/auth";
import { bad, body, route } from "@/lib/http";
import { byCode, hostLikeIdentity, isMember } from "@/lib/meet/meetings";
import { notesFromCaptions, sendNotes } from "@/lib/meet/extras";
import { requireRecorder } from "@/lib/meet/recording";
import { canSeeNotes, notesToTasks, postNotes, regenerate } from "@/lib/meet/notes";

export const dynamic = "force-dynamic";

/**
 * GET  -> { status, error, notes, transcript?, taskIds, postedAt } (host, invitees, members who joined)
 * POST { action: "regenerate" } | { action: "tasks", projectId?, items? } | { action: "post", channelId? }
 *      | { action: "send" } (notes to attendees, in the app and by email) | { action: "from_captions" }   (hosts with meetings.ai_notes)
 */
async function GET_(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  if (!(await canSeeNotes(me, m))) throw new HttpError(404, "Not found");
  return Response.json({
    title: m.title,
    code: m.code,
    host: isMember(me, m) && hostLikeIdentity(m, `u_${me.userId}`),
    status: m.notesStatus,
    error: m.notesError,
    notes: m.notesStatus === "ready" ? m.notes : null,
    transcript: m.transcript,
    sentAt: m.notesSentAt,
    taskIds: m.notesTaskIds,
    postedAt: m.notesPostedAt,
    channelId: m.channelId,
    at: m.notesAt,
  });
}

async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  const b = await body<{ action?: string; projectId?: string; items?: number[]; channelId?: string }>(req);
  if (b.action === "regenerate") return Response.json(await regenerate(me, m));
  if (b.action === "tasks") return Response.json(await notesToTasks(me, m, b));
  if (b.action === "post") return Response.json(await postNotes(me, m, b));
  if (b.action === "send") return Response.json(await sendNotes(me, m));
  if (b.action === "from_captions") {
    requireRecorder(me, m, "audio");
    return Response.json(await notesFromCaptions(m, true));
  }
  bad("Unknown action.");
}

export const GET = route(GET_);
export const POST = route(POST_);
