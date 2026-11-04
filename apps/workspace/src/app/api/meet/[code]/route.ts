import { db } from "@/lib/db";
import { can, getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode, caller, MEET_KEYS, publicInfo, settingsDto, updateSettings, type MeetingSettings } from "@/lib/meet/meetings";
import { recordingDto, refreshRecordings } from "@/lib/meet/recording";
import { dialInInfo } from "@/lib/meet/sip";

export const dynamic = "force-dynamic";

/**
 * GET   -> the meeting as anyone with the link may see it; the host also gets
 *          settings, the waiting count, recordings and what their role allows.
 * PATCH { title?, waitingRoom?, allowGuests?, muteOnEntry?, locked?, everyoneWaits?, passcode?, captionLang?,
 *         e2ee?, e2eeCheck? (host, before anyone joins), registration?, regApproval?, startsAt? (webinars) } (hosts)
 */
async function GET_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  const info = await publicInfo(m, me);
  const c = await caller(me, m, req.headers.get("x-meet-guest"));
  if (!c?.hostLike) return Response.json({ meeting: info });
  await refreshRecordings(m);
  const [waiting, recs] = await Promise.all([
    db.meetParticipant.count({ where: { meetingId: m.id, status: "waiting" } }),
    db.meetRecording.findMany({ where: { meetingId: m.id }, orderBy: { startedAt: "desc" } }),
  ]);
  return Response.json({
    meeting: {
      ...info,
      settings: { ...settingsDto(m), passcode: m.passcode },
      dialIn: dialInInfo(m),
      panelists: m.panelists,
      owner: c.owner,
      waiting,
      recordings: recs.map(recordingDto),
      notesStatus: m.notesStatus,
      channelId: m.channelId,
      can: { record: !!c.me && can(c.me, MEET_KEYS.record), aiNotes: !!c.me && can(c.me, MEET_KEYS.aiNotes), guests: !!c.me && can(c.me, MEET_KEYS.guests) },
    },
  });
}

async function PATCH_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  const b = await body<MeetingSettings & { title?: string }>(req);
  const u = await updateSettings(me, m, b, req.headers.get("x-meet-guest"));
  return Response.json({ settings: { ...settingsDto(u), passcode: u.passcode }, title: u.title });
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
