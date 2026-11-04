import { db } from "./db";
import { PermissionError } from "./iotx/permissions";
import { reportsOf } from "./structure";
import { policyOf } from "./timeoff";

/**
 * People → Reports: the monthly timesheet (hours, presence, late arrivals,
 * leave, absences) and login history. Owners and admins see everyone;
 * managers see themselves and their reporting line; everyone else sees
 * only themselves. Days are India time.
 */

const TZ = "Asia/Kolkata";
const dayIn = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const timeIn = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

async function scope(userId: string, workspaceId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } });
  if (!m) throw new PermissionError("You're not in this workspace.", 403);
  const admin = m.role === "OWNER" || m.role === "ADMIN";
  if (admin) return { admin, ids: (await db.membership.findMany({ where: { workspaceId }, select: { userId: true } })).map((x) => x.userId) };
  const profiles = await db.employeeProfile.findMany({ where: { workspaceId }, select: { userId: true, managerId: true } });
  return { admin, ids: [userId, ...reportsOf(profiles, userId)] };
}

export type DayCell = { date: string; kind: "work" | "off" | "holiday" | "leave" | "absent" | "future"; minutes: number; firstIn: string | null; late: boolean; leave?: string };

export async function timesheet(viewerId: string, workspaceId: string, month: string) {
  const m = /^\d{4}-\d{2}$/.test(month) ? month : dayIn(new Date()).slice(0, 7);
  const { admin, ids } = await scope(viewerId, workspaceId);
  const policy = await policyOf(workspaceId);
  const first = new Date(`${m}-01T00:00:00+05:30`);
  const [y, mo] = m.split("-").map(Number);
  const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const after = new Date(first.getTime() + daysIn * 86_400_000);
  const [sessions, leaves, users] = await Promise.all([
    db.workSession.findMany({ where: { workspaceId, userId: { in: ids }, startedAt: { gte: first, lt: after } }, orderBy: { startedAt: "asc" } }),
    db.leaveRequest.findMany({ where: { workspaceId, userId: { in: ids }, status: "approved", startDate: { lte: new Date(`${m}-${String(daysIn).padStart(2, "0")}T00:00:00Z`) }, endDate: { gte: new Date(`${m}-01T00:00:00Z`) } } }),
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }),
  ]);
  const holidays = new Map(policy.holidays.map((h) => [h.date, h.name]));
  const [sh, sm] = policy.workHours.start.split(":").map(Number);
  const lateAfter = sh * 60 + sm + policy.workHours.graceMin;
  const today = dayIn(new Date());
  const now = Date.now();

  const people = ids.map((id) => {
    const mine = sessions.filter((s) => s.userId === id);
    const days: DayCell[] = [];
    for (let i = 1; i <= daysIn; i++) {
      const date = `${m}-${String(i).padStart(2, "0")}`;
      const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
      const todays = mine.filter((s) => dayIn(s.startedAt) === date);
      const minutes = todays.reduce((n, s) => n + Math.max(0, Math.round(((s.endedAt?.getTime() ?? Math.min(now, s.startedAt.getTime() + 16 * 3_600_000)) - s.startedAt.getTime()) / 60_000)), 0);
      const firstIn = todays[0] ? timeIn(todays[0].startedAt) : null;
      const leave = leaves.find((l) => l.userId === id && l.startDate.toISOString().slice(0, 10) <= date && l.endDate.toISOString().slice(0, 10) >= date);
      const working = !policy.weekOff.includes(dow) && !holidays.has(date);
      const [fh, fm] = (firstIn ?? "00:00").split(":").map(Number);
      const late = !!firstIn && working && !leave && fh * 60 + fm > lateAfter;
      let kind: DayCell["kind"] = "work";
      if (todays.length) kind = "work";
      else if (holidays.has(date)) kind = "holiday";
      else if (!working) kind = "off";
      else if (leave) kind = "leave";
      // Today counts as absent only once it is over.
      else if (date >= today) kind = "future";
      else kind = "absent";
      days.push({ date, kind, minutes, firstIn, late, ...(leave ? { leave: leave.type } : {}) });
    }
    const u = users.find((x) => x.id === id);
    return {
      userId: id,
      name: u?.name || u?.email || id,
      email: u?.email ?? "",
      days,
      totals: {
        minutes: days.reduce((n, d) => n + d.minutes, 0),
        present: days.filter((d) => d.minutes > 0).length,
        late: days.filter((d) => d.late).length,
        leave: days.filter((d) => d.kind === "leave").length,
        absent: days.filter((d) => d.kind === "absent").length,
        workingDays: days.filter((d) => d.kind !== "off" && d.kind !== "holiday").length,
      },
    };
  });
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { month: m, admin, workHours: policy.workHours, holidays: policy.holidays.filter((h) => h.date.startsWith(m)), people };
}

export function timesheetCsv(t: Awaited<ReturnType<typeof timesheet>>) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const hours = (m: number) => (m / 60).toFixed(2);
  const lines = [["Name", "Email", "Hours", "Days present", "Late", "Leave days", "Absent", "Working days", ...t.people[0]?.days.map((d) => d.date) ?? []].map(cell).join(",")];
  for (const p of t.people)
    lines.push(
      [
        p.name,
        p.email,
        hours(p.totals.minutes),
        p.totals.present,
        p.totals.late,
        p.totals.leave,
        p.totals.absent,
        p.totals.workingDays,
        ...p.days.map((d) => (d.minutes ? `${hours(d.minutes)}${d.late ? " late" : ""}` : d.kind === "work" ? "" : d.kind === "leave" ? `leave (${d.leave})` : d.kind)),
      ]
        .map(cell)
        .join(","),
    );
  return lines.join("\n");
}

/** Sign-ins, newest first: everyone in the workspace for owners and admins, otherwise my own. */
export async function loginHistory(viewerId: string, workspaceId: string, opts: { page?: number; size?: number; q?: string }) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: viewerId, workspaceId } }, select: { role: true } });
  if (!m) throw new PermissionError("You're not in this workspace.", 403);
  const admin = m.role === "OWNER" || m.role === "ADMIN";
  let ids = admin ? (await db.membership.findMany({ where: { workspaceId }, select: { userId: true } })).map((x) => x.userId) : [viewerId];
  const q = opts.q?.trim().toLowerCase();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  if (q) {
    const hit = users.filter((u) => `${u.name ?? ""} ${u.email}`.toLowerCase().includes(q)).map((u) => u.id);
    ids = hit.length ? hit : ids;
  }
  const size = Math.min(Math.max(opts.size ?? 25, 10), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const where = { userId: { in: ids }, ...(q && !users.some((u) => `${u.name ?? ""} ${u.email}`.toLowerCase().includes(q)) ? { OR: [{ ip: { contains: q } }, { provider: { contains: q } }] } : {}) };
  const [total, rows] = await Promise.all([db.loginEvent.count({ where }), db.loginEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * size, take: size })]);
  const by = new Map(users.map((u) => [u.id, u]));
  return {
    admin,
    total,
    page,
    size,
    rows: rows.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), userId: r.userId, name: by.get(r.userId)?.name ?? null, email: by.get(r.userId)?.email ?? "", provider: r.provider, ip: r.ip, device: device(r.userAgent) })),
  };
}

/** A short device label from a user agent: "Chrome on Windows". */
function device(ua: string | null) {
  if (!ua) return "Unknown";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl|node|undici/i.test(ua) ? "Script" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
