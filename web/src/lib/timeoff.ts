import { db } from "./db";
import { audit } from "./workspace-security";
import { PermissionError } from "./iotx/permissions";

/**
 * Time off. A person asks; the request goes to their manager, else the head
 * of their department (or of the nearest department above it), else the
 * workspace's owners and admins. The approver, and any owner or admin, can
 * approve or reject; the person can cancel until it has started. Everyone
 * in the workspace sees who is away and when (the absence chart), but the
 * reason only reaches the person, their approver and admins.
 */

export const LEAVE_TYPES = [
  { id: "casual", label: "Casual leave", color: "#6366f1" },
  { id: "sick", label: "Sick leave", color: "#dc2626" },
  { id: "earned", label: "Earned leave", color: "#059669" },
  { id: "wfh", label: "Work from home", color: "#0891b2" },
  { id: "unpaid", label: "Unpaid leave", color: "#6b7280" },
  { id: "other", label: "Other", color: "#ca8a04" },
] as const;
const TYPE_IDS = new Set<string>(LEAVE_TYPES.map((t) => t.id));

const day = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new PermissionError("Dates must be YYYY-MM-DD.");
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new PermissionError("That isn't a real date.");
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

export type Holiday = { date: string; name: string };
export type WorkHours = { start: string; hours: number; graceMin: number };
export type PeoplePolicy = { leaveAllowance: Record<string, number>; holidays: Holiday[]; weekOff: number[]; workHours: WorkHours };
const DEFAULT_HOURS: WorkHours = { start: "09:30", hours: 8, graceMin: 10 };

/** The workspace's leave allowances, holidays and weekly off days (Sunday off by default). */
export async function policyOf(workspaceId: string): Promise<PeoplePolicy> {
  const s = await db.peopleSettings.findUnique({ where: { workspaceId } });
  const allowance = (s?.leaveAllowance as Record<string, number> | null) ?? {};
  const holidays = Array.isArray(s?.holidays) ? (s!.holidays as Holiday[]) : [];
  const weekOff = Array.isArray(s?.weekOff) ? (s!.weekOff as number[]) : [0];
  const wh = (s?.workHours as Partial<WorkHours> | null) ?? {};
  const workHours: WorkHours = {
    start: typeof wh.start === "string" && /^\d{2}:\d{2}$/.test(wh.start) ? wh.start : DEFAULT_HOURS.start,
    hours: typeof wh.hours === "number" && wh.hours > 0 && wh.hours <= 16 ? wh.hours : DEFAULT_HOURS.hours,
    graceMin: typeof wh.graceMin === "number" && wh.graceMin >= 0 && wh.graceMin <= 120 ? wh.graceMin : DEFAULT_HOURS.graceMin,
  };
  return { leaveAllowance: allowance, holidays: holidays.sort((a, b) => a.date.localeCompare(b.date)), weekOff, workHours };
}

/** Owners and admins set the allowances, holidays and off days. */
export async function savePolicy(actorId: string, workspaceId: string, b: { leaveAllowance?: unknown; holidays?: unknown; weekOff?: unknown; workHours?: unknown }) {
  if (!(await isAdmin(actorId, workspaceId))) throw new PermissionError("Only owners and admins can change leave rules.", 403);
  const data: { leaveAllowance?: Record<string, number>; holidays?: Holiday[]; weekOff?: number[]; workHours?: WorkHours } = {};
  if (b.workHours && typeof b.workHours === "object") {
    const w = b.workHours as Record<string, unknown>;
    data.workHours = {
      start: typeof w.start === "string" && /^\d{2}:\d{2}$/.test(w.start) ? w.start : DEFAULT_HOURS.start,
      hours: Math.min(16, Math.max(1, Number(w.hours) || DEFAULT_HOURS.hours)),
      graceMin: Math.min(120, Math.max(0, Math.round(Number(w.graceMin) || 0))),
    };
  }
  if (b.leaveAllowance && typeof b.leaveAllowance === "object") {
    data.leaveAllowance = {};
    for (const [k, v] of Object.entries(b.leaveAllowance as Record<string, unknown>)) {
      const n = Number(v);
      if (TYPE_IDS.has(k) && v !== "" && v !== null && Number.isFinite(n) && n >= 0 && n <= 366) data.leaveAllowance[k] = Math.round(n * 2) / 2;
    }
  }
  if (Array.isArray(b.holidays)) {
    data.holidays = (b.holidays as { date?: unknown; name?: unknown }[])
      .filter((h) => typeof h?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
      .map((h) => ({ date: String(h.date), name: String(h.name ?? "Holiday").trim().slice(0, 60) || "Holiday" }))
      .slice(0, 100);
  }
  if (Array.isArray(b.weekOff)) data.weekOff = [...new Set((b.weekOff as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].slice(0, 3);
  await db.peopleSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  await audit(workspaceId, actorId, "people.changed", "Changed the leave rules (allowances, holidays or off days)");
  return policyOf(workspaceId);
}

/** Working days between two dates, both included: weekly off days and company holidays don't count. */
export function workingDays(start: Date, end: Date, halfDay: boolean, policy: Pick<PeoplePolicy, "holidays" | "weekOff"> = { holidays: [], weekOff: [0] }) {
  const off = new Set(policy.holidays.map((h) => h.date));
  let n = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const d = new Date(t);
    if (!policy.weekOff.includes(d.getUTCDay()) && !off.has(iso(d))) n++;
  }
  return halfDay ? Math.min(n, 1) * 0.5 : n;
}

/** Days used (approved) and asked for (pending) this year, per type. */
async function usedThisYear(userId: string, workspaceId: string, year: number) {
  const rows = await db.leaveRequest.groupBy({
    by: ["type", "status"],
    where: { workspaceId, userId, status: { in: ["approved", "pending"] }, startDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
    _sum: { days: true },
  });
  const used: Record<string, number> = {};
  const pending: Record<string, number> = {};
  for (const r of rows) (r.status === "approved" ? used : pending)[r.type] = (r._sum.days ?? 0) + ((r.status === "approved" ? used : pending)[r.type] ?? 0);
  return { used, pending };
}

async function isAdmin(userId: string, workspaceId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

/** Who approves this person's time off: manager, else the nearest department head, else nobody (admins then). */
export async function approverFor(userId: string, workspaceId: string) {
  const p = await db.employeeProfile.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { managerId: true, departmentId: true } });
  if (p?.managerId && p.managerId !== userId) return p.managerId;
  if (p?.departmentId) {
    const depts = await db.department.findMany({ where: { workspaceId }, select: { id: true, parentId: true, headId: true } });
    for (let d = depts.find((x) => x.id === p.departmentId); d; d = depts.find((x) => x.id === d!.parentId)) if (d.headId && d.headId !== userId) return d.headId;
  }
  return null;
}

async function tell(userIds: string[], title: string, body: string) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length) await db.notification.createMany({ data: ids.map((userId) => ({ userId, kind: "timeoff", title, body, href: "/people?view=timeoff" })) }).catch(() => undefined);
}
const nameOf = async (id: string) => {
  const u = await db.user.findUnique({ where: { id }, select: { name: true, email: true } });
  return u?.name || u?.email || "Someone";
};
const range = (r: { startDate: Date; endDate: Date; halfDay: boolean }) =>
  `${iso(r.startDate)}${iso(r.endDate) !== iso(r.startDate) ? ` to ${iso(r.endDate)}` : ""}${r.halfDay ? " (half day)" : ""}`;

export async function requestTimeOff(userId: string, workspaceId: string, b: { type?: unknown; start?: unknown; end?: unknown; halfDay?: unknown; reason?: unknown }) {
  const type = String(b.type ?? "");
  if (!TYPE_IDS.has(type)) throw new PermissionError("Choose a type of leave.");
  const start = day(String(b.start ?? ""));
  const end = day(String(b.end ?? b.start ?? ""));
  if (end < start) throw new PermissionError("The last day is before the first.");
  if (end.getTime() - start.getTime() > 120 * 86_400_000) throw new PermissionError("Ask for at most four months at a time.");
  const halfDay = b.halfDay === true && iso(start) === iso(end);
  const policy = await policyOf(workspaceId);
  const days = workingDays(start, end, halfDay, policy);
  if (!days) throw new PermissionError("Those days are all off days or holidays.");
  // Within the yearly allowance for that type (pending requests count too).
  const limit = policy.leaveAllowance[type];
  if (limit !== undefined) {
    const { used, pending } = await usedThisYear(userId, workspaceId, start.getUTCFullYear());
    const left = limit - (used[type] ?? 0) - (pending[type] ?? 0);
    if (days > left) throw new PermissionError(`That's ${days} ${days === 1 ? "day" : "days"}, but only ${Math.max(0, left)} ${LEAVE_TYPES.find((t) => t.id === type)!.label.toLowerCase()} ${left === 1 ? "day is" : "days are"} left this year.`);
  }
  const clash = await db.leaveRequest.findFirst({ where: { workspaceId, userId, status: { in: ["pending", "approved"] }, startDate: { lte: end }, endDate: { gte: start } } });
  if (clash) throw new PermissionError(`You already have time off from ${range(clash)}.`);
  const approverId = await approverFor(userId, workspaceId);
  const admins = approverId ? [] : (await db.membership.findMany({ where: { workspaceId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } })).map((m) => m.userId).filter((x) => x !== userId);
  // Nobody above them and no other admin (a sole owner): recorded as approved, so it still shows on the chart.
  const solo = !approverId && !admins.length;
  const r = await db.leaveRequest.create({
    data: {
      workspaceId,
      userId,
      type,
      startDate: start,
      endDate: end,
      halfDay,
      days,
      reason: typeof b.reason === "string" ? b.reason.trim().slice(0, 500) || null : null,
      approverId,
      ...(solo ? { status: "approved", decidedById: userId, decidedAt: new Date(), decisionNote: "No one else to approve it" } : {}),
    },
  });
  const who = await nameOf(userId);
  const label = LEAVE_TYPES.find((t) => t.id === type)!.label;
  if (!solo) await tell(approverId ? [approverId] : admins, `${who} asked for ${label.toLowerCase()}`, `${range(r)} · ${days} ${days === 1 ? "day" : "days"}. Approve or reject in People → Time off.`);
  await audit(workspaceId, userId, "people.changed", `Asked for ${label.toLowerCase()} ${range(r)}`);
  return r;
}

export async function decideTimeOff(actorId: string, workspaceId: string, id: string, approve: boolean, note?: string) {
  const r = await db.leaveRequest.findFirst({ where: { id, workspaceId } });
  if (!r) throw new PermissionError("That request doesn't exist.", 404);
  if (r.status !== "pending") throw new PermissionError(`It's already ${r.status}.`);
  if (r.userId === actorId) throw new PermissionError("Someone else has to decide your own time off.", 403);
  if (r.approverId !== actorId && !(await isAdmin(actorId, workspaceId))) throw new PermissionError("Only their approver or an admin can decide this.", 403);
  const out = await db.leaveRequest.update({
    where: { id },
    data: { status: approve ? "approved" : "rejected", decidedById: actorId, decidedAt: new Date(), decisionNote: note?.trim().slice(0, 500) || null },
  });
  const by = await nameOf(actorId);
  await tell([r.userId], `Your time off was ${approve ? "approved" : "rejected"}`, `${range(r)} · by ${by}${note?.trim() ? `: ${note.trim().slice(0, 200)}` : ""}`);
  await audit(workspaceId, actorId, "people.changed", `${approve ? "Approved" : "Rejected"} time off for ${await nameOf(r.userId)} (${range(r)})`);
  return out;
}

export async function cancelTimeOff(userId: string, workspaceId: string, id: string) {
  const r = await db.leaveRequest.findFirst({ where: { id, workspaceId } });
  if (!r) throw new PermissionError("That request doesn't exist.", 404);
  if (r.userId !== userId && !(await isAdmin(userId, workspaceId))) throw new PermissionError("Only the person or an admin can cancel it.", 403);
  if (r.status === "cancelled" || r.status === "rejected") throw new PermissionError(`It's already ${r.status}.`);
  if (r.status === "approved" && r.startDate.getTime() <= Date.now() && r.userId === userId) throw new PermissionError("It has already started; ask an admin to change it.");
  const out = await db.leaveRequest.update({ where: { id }, data: { status: "cancelled" } });
  if (r.approverId && r.approverId !== userId) await tell([r.approverId], `${await nameOf(r.userId)} cancelled their time off`, range(r));
  return out;
}

/** My requests, what's waiting for me, and the absence chart for a month. */
export async function timeOffView(userId: string, workspaceId: string, month: string) {
  const m = /^\d{4}-\d{2}$/.test(month) ? month : iso(new Date()).slice(0, 7);
  const from = new Date(`${m}-01T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  const admin = await isAdmin(userId, workspaceId);
  const [mine, waiting, inMonth] = await Promise.all([
    db.leaveRequest.findMany({ where: { workspaceId, userId }, orderBy: { startDate: "desc" }, take: 50 }),
    db.leaveRequest.findMany({ where: { workspaceId, status: "pending", userId: { not: userId }, ...(admin ? {} : { approverId: userId }) }, orderBy: { startDate: "asc" }, take: 200 }),
    db.leaveRequest.findMany({ where: { workspaceId, status: { in: ["pending", "approved"] }, startDate: { lte: to }, endDate: { gte: from } }, orderBy: { startDate: "asc" } }),
  ]);
  const seesReason = (r: { userId: string; approverId: string | null }) => admin || r.userId === userId || r.approverId === userId;
  const dto = (r: (typeof mine)[number]) => ({
    id: r.id,
    userId: r.userId,
    type: r.type,
    start: iso(r.startDate),
    end: iso(r.endDate),
    halfDay: r.halfDay,
    days: r.days,
    status: r.status,
    reason: seesReason(r) ? r.reason : null,
    approverId: r.approverId,
    decidedById: r.decidedById,
    decisionNote: seesReason(r) ? r.decisionNote : null,
    createdAt: r.createdAt.toISOString(),
  });
  const year = new Date().getUTCFullYear();
  const { used, pending } = await usedThisYear(userId, workspaceId, year);
  const policy = await policyOf(workspaceId);
  return {
    policy,
    balances: Object.fromEntries(LEAVE_TYPES.map((t) => [t.id, { allowance: policy.leaveAllowance[t.id] ?? null, used: used[t.id] ?? 0, pending: pending[t.id] ?? 0 }])),
    month: m,
    types: LEAVE_TYPES,
    myApprover: await approverFor(userId, workspaceId),
    takenThisYear: used,
    mine: mine.map(dto),
    waiting: waiting.map(dto),
    chart: inMonth.map(dto),
    admin,
  };
}

/** Who is away between two dates (for the AI and the chart). */
export async function awayBetween(workspaceId: string, from: Date, to: Date) {
  return db.leaveRequest.findMany({ where: { workspaceId, status: "approved", startDate: { lte: to }, endDate: { gte: from } }, orderBy: { startDate: "asc" } });
}
