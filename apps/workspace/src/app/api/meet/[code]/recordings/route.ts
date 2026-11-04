import { db } from "@/lib/db";
import { getMe, HttpError } from "@/lib/auth";
import { route } from "@/lib/http";
import { byCode, hostLikeIdentity, isMember } from "@/lib/meet/meetings";
import { canSeeHistory } from "@/lib/meet/extras";
import { canSeeReport } from "@/lib/meet/read";
import { recordingDto, refreshRecordings } from "@/lib/meet/recording";

export const dynamic = "force-dynamic";

/** GET -> { recordings } finished recordings for the host, invitees and members who joined (hosts also see failed ones). */
async function GET_(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  if (!(await canSeeHistory(me, m)) && !(await canSeeReport(me, m))) throw new HttpError(404, "Not found");
  const host = isMember(me, m) && hostLikeIdentity(m, `u_${me.userId}`);
  if (host) await refreshRecordings(m);
  const recs = await db.meetRecording.findMany({ where: { meetingId: m.id, deletedAt: null, ...(host ? {} : { status: "complete" }) }, orderBy: { startedAt: "desc" } });
  return Response.json({ recordings: recs.map(recordingDto), host });
}

export const GET = route(GET_);
