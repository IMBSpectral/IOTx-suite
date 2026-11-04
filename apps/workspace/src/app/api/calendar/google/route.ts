import { db } from "@/lib/db";
import { can, requireMe } from "@/lib/auth";
import { googleCalendars, hasCalendarAccess, linkGoogleCalendar, syncBirthdays, syncUser, unlinkGoogleCalendar } from "@/lib/google";
import { SUITE_PUBLIC_URL } from "@/lib/env";
import { body, route } from "@/lib/http";

/**
 * GET  -> { allowed, connected, lastSyncAt, error, connectUrl, birthdaysAt, birthdaysError }
 * GET ?calendars=1 -> { calendars: [{ id, name, primary, color, accessRole, link: { calendarId, readOnly, lastSyncAt, error } | null }] }
 * POST { action: "sync" } -> runs a sync now and answers its counts.
 * POST { action: "link", googleCalId, calendarId: "new" | <one of my calendars> } -> sync another Google calendar into it (then syncs).
 * POST { action: "unlink", googleCalId } -> stop syncing it (the calendar and its events stay).
 * POST { action: "birthdays" } -> read Google contacts' birthdays now.
 */
async function GET_(req: Request) {
  const me = await requireMe("calendar.open");
  const allowed = can(me, "calendar.google");
  const connected = allowed ? await hasCalendarAccess(me.userId) : false;
  if (new URL(req.url).searchParams.get("calendars")) {
    if (!connected) return Response.json({ error: "Connect Google Calendar first.", reconnect: true }, { status: 409 });
    try {
      return Response.json({ calendars: await googleCalendars(me.userId, me.ws) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
  }
  const st = await db.googleSync.findUnique({ where: { userId: me.userId } });
  return Response.json({
    allowed,
    connected,
    lastSyncAt: st?.lastSyncAt ?? null,
    error: connected ? (st?.error === "reconnect" ? null : st?.error ?? null) : null,
    connectUrl: `${SUITE_PUBLIC_URL}/api/google/connect?back=${encodeURIComponent("/workspace/calendar")}`,
    birthdaysAt: st?.birthdaysAt ?? null,
    birthdaysError: st?.birthdaysError ?? null,
  });
}

async function POST_(req: Request) {
  const me = await requireMe(["calendar.open", "calendar.google"]);
  const b = await body<{ action?: string; googleCalId?: string; calendarId?: string }>(req);
  if (!["sync", "link", "unlink", "birthdays"].includes(String(b.action))) return Response.json({ error: "Unknown action" }, { status: 400 });
  if (b.action === "unlink") return Response.json(await unlinkGoogleCalendar(me.userId, String(b.googleCalId ?? "")));
  if (!(await hasCalendarAccess(me.userId))) return Response.json({ error: "Connect Google Calendar first.", reconnect: true }, { status: 409 });
  if (b.action === "link") {
    try {
      const r = await linkGoogleCalendar(me.userId, me.ws, String(b.googleCalId ?? ""), String(b.calendarId ?? "new"));
      return Response.json({ ...r, sync: await syncUser(me.userId, me.ws) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  if (b.action === "birthdays") return Response.json(await syncBirthdays(me.userId));
  return Response.json(await syncUser(me.userId, me.ws));
}

export const GET = route(GET_);
export const POST = route(POST_);
