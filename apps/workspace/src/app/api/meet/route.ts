import { requireMe } from "@/lib/auth";
import { occurrences } from "@/lib/calendar";
import { body, route } from "@/lib/http";
import { createMeeting, meetingUrl, myMeetings, MEET_KEYS, settingsDto } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/**
 * GET  -> { meetings (mine, newest first), upcoming (calendar events in the next 7 days with a Meet link) }
 * POST { title?, waitingRoom?, allowGuests?, muteOnEntry?, invitees?: userId[], passcode?,
 *        e2ee?, e2eeCheck? (end-to-end encryption: the browser keeps the key, we keep a check value),
 *        kind?: "webinar", startsAt?, registration?, regApproval?, panelists?: (userId | email)[] }
 *   -> 201 { meeting: { code, url, registerUrl?, ... } }
 */
async function GET_() {
  const me = await requireMe(MEET_KEYS.open);
  const now = new Date();
  const occ = me.perms["calendar.open"] ? await occurrences(me, new Date(now.getTime() - 60 * 60_000), new Date(now.getTime() + 7 * 86_400_000)).catch(() => []) : [];
  const upcoming = occ
    .filter((o) => o.conferenceUrl && new Date(o.end) > now)
    .slice(0, 20)
    .map((o) => {
      const code = /\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})/.exec(o.conferenceUrl ?? "")?.[1] ?? null;
      return { id: o.id, title: o.title, start: o.start, end: o.end, allDay: o.allDay, url: o.conferenceUrl, code };
    });
  return Response.json({ meetings: await myMeetings(me), upcoming });
}

async function POST_(req: Request) {
  const me = await requireMe(MEET_KEYS.open);
  const b = await body<Parameters<typeof createMeeting>[1]>(req);
  const m = await createMeeting(me, b);
  const url = meetingUrl(req, m.code);
  return Response.json(
    { meeting: { code: m.code, title: m.title, url, host: true, ...settingsDto(m), ...(m.kind === "webinar" ? { registerUrl: `${url}/register` } : {}) } },
    { status: 201 },
  );
}

export const GET = route(GET_);
export const POST = route(POST_);
