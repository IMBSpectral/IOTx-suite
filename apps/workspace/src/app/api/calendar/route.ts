import { db } from "@/lib/db";
import { can, requireMe } from "@/lib/auth";
import { occurrences } from "@/lib/calendar";
import { calendarList, getSettings, refreshSubscriptions } from "@/lib/cal-plus";
import { birthdayOccurrences, birthdaysCalendar } from "@/lib/cal-more";
import { hasCalendarAccess, syncUser } from "@/lib/google";
import { bad, route } from "@/lib/http";

/**
 * GET ?from=ISO&to=ISO -> { calendars (with my access, shares and subscriptions, plus Birthdays), events (occurrences and birthdays), tasks (due dates), settings }
 * Opening Calendar also starts a Google sync (when connected and not synced in the last 20s).
 */
async function GET_(req: Request) {
  const me = await requireMe("calendar.open");
  const q = new URL(req.url).searchParams;
  const from = new Date(q.get("from") ?? Date.now() - 7 * 86_400_000);
  const to = new Date(q.get("to") ?? Date.now() + 35 * 86_400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) bad("from and to must be dates");
  if (to.getTime() - from.getTime() > 400 * 86_400_000) bad("That range is too long.");
  await db.user.update({ where: { id: me.userId }, data: { calendarSeenAt: new Date() } });
  if (can(me, "calendar.google") && q.get("sync") !== "0") {
    const st = await db.googleSync.findUnique({ where: { userId: me.userId } });
    if (!st?.lastSyncAt || Date.now() - st.lastSyncAt.getTime() > 20_000) {
      void hasCalendarAccess(me.userId).then((ok) => (ok ? syncUser(me.userId, me.ws) : null)).catch(() => {});
    }
  }
  void refreshSubscriptions().catch(() => {});
  const [calendars, events, tasks, settings, birthdays] = await Promise.all([
    calendarList(me),
    occurrences(me, from, to),
    can(me, "tasks.open") ? dueTasks(me.ws, me.userId, from, to) : Promise.resolve([]),
    getSettings(me),
    // The Birthdays calendar: its own entry in the list, yearly all-day entries in range.
    Promise.all([birthdaysCalendar(me), birthdayOccurrences(me, from, to)]),
  ]);
  const all = [...events, ...birthdays[1]].sort((a, b) => a.start.localeCompare(b.start));
  return Response.json({ calendars: [...calendars, birthdays[0]], events: all, tasks, settings });
}

/** Tasks with due dates in range, in projects I'm in (assigned to me or not), shown as all-day items. */
async function dueTasks(ws: string, userId: string, from: Date, to: Date) {
  const fromDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - 1));
  const rows = await db.task.findMany({
    where: { ws, due: { gte: fromDay, lt: to }, project: { archived: false, members: { some: { userId } } } },
    include: { project: { select: { name: true, color: true, key: true } } },
    take: 500,
  });
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  return rows.map((t) => ({
    id: t.id,
    title: t.project.key ? `${t.project.key}-${t.number} ${t.title}` : t.title,
    due: t.due!.toISOString().slice(0, 10),
    // Calendar only needs to know finished or not; the project's workflow decides which status that is.
    status: t.completedAt ? "done" : t.status,
    projectId: t.projectId,
    project: t.project.name,
    color: t.project.color,
    assigneeId: t.assigneeId,
    overdue: !t.completedAt && t.due! < today,
  }));
}

export const GET = route(GET_);
