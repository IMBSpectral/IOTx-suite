import { db } from "./db";
import { audit } from "./workspace-security";
import { PermissionError } from "./iotx/permissions";
import { approverFor } from "./timeoff";
import { reportsOf } from "./structure";

/**
 * Work time and daily reports. People clock in and out (one open stretch at
 * a time) and write a short daily report, which goes to their manager (or
 * department head). Managers see their team's hours and reports, down the
 * whole reporting line; owners and admins see everyone. Days are the
 * workspace's calendar days in India time unless a time zone is given.
 */

const TZ = "Asia/Kolkata";
/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
const dayIn = (d: Date, tz = TZ) => d.toLocaleDateString("en-CA", { timeZone: tz });
/** Midnight UTC of a YYYY-MM-DD day (how report dates are stored). */
const asDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new PermissionError("Dates must be YYYY-MM-DD.");
  return new Date(`${s}T00:00:00Z`);
};
const minutes = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

async function isAdmin(userId: string, workspaceId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

export async function clockIn(userId: string, workspaceId: string, note?: string) {
  const open = await db.workSession.findFirst({ where: { workspaceId, userId, endedAt: null } });
  if (open) throw new PermissionError("You're already clocked in.");
  return db.workSession.create({ data: { workspaceId, userId, startedAt: new Date(), note: note?.trim().slice(0, 200) || null } });
}

export async function clockOut(userId: string, workspaceId: string) {
  const open = await db.workSession.findFirst({ where: { workspaceId, userId, endedAt: null } });
  if (!open) throw new PermissionError("You aren't clocked in.");
  // A stretch left open past 16 hours is closed at 16 hours, not at now.
  const end = new Date(Math.min(Date.now(), open.startedAt.getTime() + 16 * 3_600_000));
  return db.workSession.update({ where: { id: open.id }, data: { endedAt: end } });
}

/** Sessions that started within [from, to), with minutes (an open one counts up to now). */
async function sessionsFor(workspaceId: string, userIds: string[], from: Date, to: Date) {
  const rows = await db.workSession.findMany({ where: { workspaceId, userId: { in: userIds }, startedAt: { gte: from, lt: to } }, orderBy: { startedAt: "asc" } });
  return rows.map((r) => ({ ...r, minutes: minutes(r.startedAt, r.endedAt ?? new Date()) }));
}

/** Monday 00:00 of this week, and today's start, in India time (as instants). */
function bounds(now = new Date()) {
  const today = dayIn(now);
  const startOfToday = new Date(`${today}T00:00:00+05:30`);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const startOfWeek = new Date(startOfToday.getTime() - ((dow + 6) % 7) * 86_400_000);
  return { today, startOfToday, startOfWeek, end: new Date(startOfToday.getTime() + 86_400_000) };
}

export async function myWorkTime(userId: string, workspaceId: string) {
  const b = bounds();
  const [week, open, report, recent, managerId] = await Promise.all([
    sessionsFor(workspaceId, [userId], b.startOfWeek, b.end),
    db.workSession.findFirst({ where: { workspaceId, userId, endedAt: null } }),
    db.workReport.findUnique({ where: { workspaceId_userId_date: { workspaceId, userId, date: asDate(b.today) } } }),
    db.workReport.findMany({ where: { workspaceId, userId }, orderBy: { date: "desc" }, take: 7 }),
    approverFor(userId, workspaceId),
  ]);
  const today = week.filter((s) => s.startedAt >= b.startOfToday);
  return {
    today: b.today,
    open: open ? { id: open.id, startedAt: open.startedAt.toISOString() } : null,
    todayMinutes: today.reduce((n, s) => n + s.minutes, 0),
    weekMinutes: week.reduce((n, s) => n + s.minutes, 0),
    sessions: today.map((s) => ({ id: s.id, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null, minutes: s.minutes })),
    report: report && { id: report.id, done: report.done, next: report.next, blockers: report.blockers, seenAt: report.seenAt?.toISOString() ?? null, comment: report.comment },
    recent: recent.map((r) => ({ date: r.date.toISOString().slice(0, 10), done: r.done, seen: !!r.seenAt, comment: r.comment })),
    managerId,
  };
}

export async function saveReport(userId: string, workspaceId: string, b: { date?: unknown; done?: unknown; next?: unknown; blockers?: unknown }) {
  const date = asDate(typeof b.date === "string" && b.date ? b.date : bounds().today);
  const done = typeof b.done === "string" ? b.done.trim().slice(0, 4000) : "";
  if (!done) throw new PermissionError("Write what you did today.");
  const managerId = await approverFor(userId, workspaceId);
  const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 2000) || null : null);
  const existed = await db.workReport.findUnique({ where: { workspaceId_userId_date: { workspaceId, userId, date } } });
  const r = await db.workReport.upsert({
    where: { workspaceId_userId_date: { workspaceId, userId, date } },
    create: { workspaceId, userId, date, done, next: text(b.next), blockers: text(b.blockers), managerId },
    update: { done, next: text(b.next), blockers: text(b.blockers), managerId, seenAt: null },
  });
  if (managerId && !existed) {
    const u = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    await db.notification
      .create({ data: { userId: managerId, kind: "worktime", title: `${u?.name || u?.email} sent their daily report`, body: done.slice(0, 160), href: "/people?view=worktime" } })
      .catch(() => undefined);
  }
  return r;
}

/** The manager (or an admin) reads a report and can leave a comment for the person. */
export async function reviewReport(actorId: string, workspaceId: string, id: string, comment?: string) {
  const r = await db.workReport.findFirst({ where: { id, workspaceId } });
  if (!r) throw new PermissionError("That report doesn't exist.", 404);
  const profiles = await db.employeeProfile.findMany({ where: { workspaceId }, select: { userId: true, managerId: true } });
  if (r.managerId !== actorId && !reportsOf(profiles, actorId).has(r.userId) && !(await isAdmin(actorId, workspaceId))) throw new PermissionError("Only their manager or an admin can review this.", 403);
  const c = comment?.trim().slice(0, 1000) || null;
  const out = await db.workReport.update({ where: { id }, data: { seenAt: new Date(), ...(c ? { comment: c } : {}) } });
  if (c) {
    const u = await db.user.findUnique({ where: { id: actorId }, select: { name: true, email: true } });
    await db.notification
      .create({ data: { userId: r.userId, kind: "worktime", title: `${u?.name || u?.email} commented on your daily report`, body: c.slice(0, 160), href: "/people?view=worktime" } })
      .catch(() => undefined);
    await audit(workspaceId, actorId, "people.changed", "Commented on a daily report");
  }
  return out;
}

/** My team's (or, for admins, everyone's) hours this week and their reports for a day. */
export async function teamWorkTime(userId: string, workspaceId: string, day?: string) {
  const b = bounds();
  const admin = await isAdmin(userId, workspaceId);
  const profiles = await db.employeeProfile.findMany({ where: { workspaceId }, select: { userId: true, managerId: true } });
  const ids = admin ? (await db.membership.findMany({ where: { workspaceId }, select: { userId: true } })).map((m) => m.userId).filter((x) => x !== userId) : [...reportsOf(profiles, userId)];
  if (!ids.length) return { people: [], day: day || b.today, admin };
  const date = asDate(day || b.today);
  const [week, reports] = await Promise.all([
    sessionsFor(workspaceId, ids, b.startOfWeek, b.end),
    db.workReport.findMany({ where: { workspaceId, userId: { in: ids }, date } }),
  ]);
  return {
    day: date.toISOString().slice(0, 10),
    admin,
    people: ids.map((id) => {
      const mine = week.filter((s) => s.userId === id);
      const open = mine.find((s) => !s.endedAt);
      const r = reports.find((x) => x.userId === id);
      return {
        userId: id,
        in: open ? open.startedAt.toISOString() : null,
        todayMinutes: mine.filter((s) => s.startedAt >= b.startOfToday).reduce((n, s) => n + s.minutes, 0),
        weekMinutes: mine.reduce((n, s) => n + s.minutes, 0),
        report: r && { id: r.id, done: r.done, next: r.next, blockers: r.blockers, seen: !!r.seenAt, comment: r.comment },
      };
    }),
  };
}

