import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "./db";
import { HttpError, type Me } from "./auth";
import { bad, str } from "./http";
import { notify } from "./notify";
import { cleanFieldDefs, cleanTemplates } from "./tasks-fields";
import { cleanFeatures, cleanQuickFilters } from "./tasks-board";
import { changed, cleanWorkflow, createTask, ensureKeys, listTasks, loadProject, loadTask, suggestKey, uniqueKey, workflow, type TaskQuery } from "./tasks";

/**
 * The planning side of Tasks: projects and their settings (key, workflow,
 * labels, roles), sprints and the backlog, reports, saved filters,
 * automation rules, repeating issues, attachments and CSV.
 */

// ── Projects ───────────────────────────────────────────────────────────────

const COLOR = /^#[0-9a-f]{6}$/i;

export async function projectDto(p: Awaited<ReturnType<typeof loadProject>> | (Parameters<typeof ensureKeys>[0] & { members: { userId: string; role: string }[] }), meId: string) {
  const open = await db.task.count({ where: { projectId: p.id, parentId: null, completedAt: null } });
  const active = await db.sprint.findFirst({ where: { projectId: p.id, state: "active" }, select: { id: true, name: true, endAt: true } });
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    color: p.color,
    leadId: p.leadId,
    createdBy: p.createdBy,
    archived: p.archived,
    statuses: workflow(p),
    labelDefs: (p.labelDefs as { name: string; color: string }[]) ?? [],
    fieldDefs: (p.fieldDefs as unknown[]) ?? [],
    quickFilters: (p.quickFilters as unknown[]) ?? [],
    features: cleanFeatures(p.features),
    templates: (p.templates as unknown[]) ?? [],
    members: p.members.map((m) => ({ userId: m.userId, role: m.role })),
    memberIds: p.members.map((m) => m.userId),
    myRole: p.members.find((m) => m.userId === meId)?.role ?? "member",
    open,
    activeSprint: active,
  };
}

export async function listProjects(me: Me, opts: { archived?: boolean } = {}) {
  const ps = await db.project.findMany({ where: { ws: me.ws, archived: !!opts.archived, members: { some: { userId: me.userId } } }, include: { members: true }, orderBy: { createdAt: "asc" } });
  const out = [];
  for (const p of ps) out.push(await projectDto({ ...p, ...(await ensureKeys(p)) }, me.userId));
  return out;
}

export async function createProject(me: Me, b: { name?: string; key?: string; color?: string; description?: string; memberIds?: string[] }) {
  const name = str(b.name, 120);
  if (!name) bad("Give the project a name.");
  const key = await uniqueKey(me.ws, b.key?.trim() ? b.key : suggestKey(name));
  const known = await db.member.findMany({ where: { ws: me.ws, userId: { in: (b.memberIds ?? []).slice(0, 200) } } });
  const ids = [...new Set([me.userId, ...known.map((k) => k.userId)])];
  const p = await db.project.create({
    data: {
      ws: me.ws, name, key, description: str(b.description, 2000), color: b.color && COLOR.test(b.color) ? b.color : "#16a34a", createdBy: me.userId, leadId: me.userId,
      members: { create: ids.map((userId) => ({ userId, role: userId === me.userId ? "admin" : "member" })) },
    },
    include: { members: true },
  });
  return projectDto(p, me.userId);
}

/** Project settings: the creator, a project admin or the workspace owner. */
export async function updateProject(me: Me, id: string, b: Record<string, unknown>) {
  const p = await loadProject(me, id);
  if (p.createdBy !== me.userId && p.myRole !== "admin" && !me.owner) throw new HttpError(403, "Only a project admin can change its settings.");
  const data: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const n = str(b.name, 120);
    if (!n) bad("Give the project a name.");
    data.name = n;
  }
  if (b.description !== undefined) data.description = str(b.description, 2000);
  if (typeof b.color === "string" && COLOR.test(b.color)) data.color = b.color;
  if (typeof b.archived === "boolean") data.archived = b.archived;
  if (b.leadId !== undefined) data.leadId = b.leadId && p.members.some((m) => m.userId === b.leadId) ? b.leadId : null;
  if (typeof b.key === "string" && b.key.toUpperCase() !== p.key) data.key = await uniqueKey(me.ws, b.key, p.id);
  if (b.statuses !== undefined) {
    const used = await db.task.groupBy({ by: ["status"], where: { projectId: p.id } });
    data.statuses = cleanWorkflow(b.statuses, new Set(used.map((u) => u.status)));
  }
  if (b.fieldDefs !== undefined) data.fieldDefs = cleanFieldDefs(b.fieldDefs);
  if (b.quickFilters !== undefined) data.quickFilters = cleanQuickFilters(b.quickFilters);
  if (b.features !== undefined) data.features = cleanFeatures(b.features);
  if (b.templates !== undefined) data.templates = cleanTemplates(b.templates);
  if (b.labelDefs !== undefined) {
    if (!Array.isArray(b.labelDefs)) bad("Labels are a list.");
    data.labelDefs = (b.labelDefs as { name?: string; color?: string }[])
      .map((l) => ({ name: str(l.name, 40), color: l.color && COLOR.test(l.color) ? l.color : "#64748b" }))
      .filter((l) => l.name)
      .slice(0, 100);
  }
  await db.project.update({ where: { id }, data });
  if (Array.isArray(b.members) || Array.isArray(b.memberIds)) {
    const wanted: { userId: string; role: string }[] = Array.isArray(b.members)
      ? (b.members as { userId: string; role?: string }[]).map((m) => ({ userId: String(m.userId), role: ["admin", "member", "viewer"].includes(String(m.role)) ? String(m.role) : "member" }))
      : (b.memberIds as string[]).map((userId) => ({ userId, role: p.members.find((m) => m.userId === userId)?.role ?? "member" }));
    const known = new Set((await db.member.findMany({ where: { ws: me.ws, userId: { in: wanted.map((w) => w.userId).slice(0, 300) } } })).map((k) => k.userId));
    const keep = new Map(wanted.filter((w) => known.has(w.userId)).map((w) => [w.userId, w.role]));
    keep.set(p.createdBy, "admin");
    keep.set(me.userId, keep.get(me.userId) === "viewer" ? "admin" : (keep.get(me.userId) ?? "admin"));
    await db.projectMember.deleteMany({ where: { projectId: id, userId: { notIn: [...keep.keys()] } } });
    for (const [userId, role] of keep) await db.projectMember.upsert({ where: { projectId_userId: { projectId: id, userId } }, create: { projectId: id, userId, role }, update: { role } });
    await db.task.updateMany({ where: { projectId: id, assigneeId: { notIn: [...keep.keys()] } }, data: { assigneeId: null } });
  }
  changed(me, id, []);
  const fresh = await db.project.findUniqueOrThrow({ where: { id }, include: { members: true } });
  return projectDto(fresh, me.userId);
}

// ── Sprints and the backlog ────────────────────────────────────────────────

async function sprintFor(me: Me, id: string) {
  const s = await db.sprint.findUnique({ where: { id } });
  if (!s) throw new HttpError(404, "Sprint not found");
  const p = await loadProject(me, s.projectId, { write: true });
  return { s, p };
}

export async function listSprints(me: Me, projectId: string) {
  await loadProject(me, projectId);
  return db.sprint.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }] });
}

export async function createSprint(me: Me, projectId: string, b: { name?: string; goal?: string; startAt?: string; endAt?: string }) {
  const p = await loadProject(me, projectId, { write: true });
  const n = await db.sprint.count({ where: { projectId } });
  return db.sprint.create({
    data: { projectId, name: str(b.name, 80) || `${p.key} Sprint ${n + 1}`, goal: str(b.goal, 500), startAt: b.startAt ? new Date(b.startAt) : null, endAt: b.endAt ? new Date(b.endAt) : null },
  });
}

async function snapshot(projectId: string, sprintId: string) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const rows = await db.task.findMany({ where: { sprintId, parentId: null }, select: { id: true, points: true, status: true, completedAt: true } });
  const done = rows.filter((r) => workflow(p).find((s) => s.id === r.status)?.category === "done");
  return { issues: rows.length, points: rows.reduce((a, r) => a + (r.points ?? 0), 0), doneIssues: done.length, donePoints: done.reduce((a, r) => a + (r.points ?? 0), 0), ids: rows.map((r) => r.id) };
}

export async function updateSprint(me: Me, id: string, b: { name?: string; goal?: string; startAt?: string | null; endAt?: string | null; action?: "start" | "complete"; moveTo?: string }) {
  const { s, p } = await sprintFor(me, id);
  if (b.action === "start") {
    if (s.state !== "planned") bad("Only a planned sprint can start.");
    if (await db.sprint.findFirst({ where: { projectId: p.id, state: "active" } })) bad("Another sprint is running. Complete it first.");
    const startAt = b.startAt ? new Date(b.startAt) : new Date();
    const endAt = b.endAt ? new Date(b.endAt) : s.endAt ?? new Date(startAt.getTime() + 14 * 86_400_000);
    if (endAt <= startAt) bad("The sprint has to end after it starts.");
    const u = await db.sprint.update({ where: { id }, data: { state: "active", startAt, endAt, stats: { start: await snapshot(p.id, id) } } });
    changed(me, p.id, []);
    return u;
  }
  if (b.action === "complete") {
    if (s.state !== "active") bad("Only the running sprint can be completed.");
    const end = await snapshot(p.id, id);
    // Unfinished issues move to the chosen sprint, or back to the backlog.
    let target: string | null = null;
    if (b.moveTo && b.moveTo !== "backlog") {
      const t = await db.sprint.findUnique({ where: { id: b.moveTo } });
      if (!t || t.projectId !== p.id || t.state === "closed" || t.id === id) bad("Move unfinished issues to a planned sprint or the backlog.");
      target = t.id;
    }
    const doneIds = workflow(p).filter((x) => x.category === "done").map((x) => x.id);
    const moved = await db.task.updateMany({ where: { sprintId: id, status: { notIn: doneIds } }, data: { sprintId: target } });
    const u = await db.sprint.update({ where: { id }, data: { state: "closed", completedAt: new Date(), stats: { ...((s.stats as object) ?? {}), end, carried: moved.count } } });
    changed(me, p.id, []);
    return u;
  }
  const data: Record<string, unknown> = {};
  if (b.name !== undefined) data.name = str(b.name, 80) || s.name;
  if (b.goal !== undefined) data.goal = str(b.goal, 500);
  if (b.startAt !== undefined) data.startAt = b.startAt ? new Date(b.startAt) : null;
  if (b.endAt !== undefined) data.endAt = b.endAt ? new Date(b.endAt) : null;
  return db.sprint.update({ where: { id }, data });
}

export async function deleteSprint(me: Me, id: string) {
  const { s, p } = await sprintFor(me, id);
  if (s.state === "active") bad("Complete the running sprint instead of deleting it.");
  await db.task.updateMany({ where: { sprintId: id }, data: { sprintId: null } });
  await db.sprint.delete({ where: { id } });
  changed(me, p.id, []);
  return { ok: true };
}

// ── Reports ────────────────────────────────────────────────────────────────

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
function days(from: Date, to: Date) {
  const out: string[] = [];
  for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); d <= to && out.length < 400; d = new Date(d.getTime() + 86_400_000)) out.push(dayKey(d));
  return out;
}

/** Burndown of the running (or a given) sprint: points and issues left each day, with the ideal line. */
export async function burndown(me: Me, projectId: string, sprintId?: string) {
  const p = await loadProject(me, projectId);
  const s = sprintId ? await db.sprint.findUnique({ where: { id: sprintId } }) : await db.sprint.findFirst({ where: { projectId, state: { in: ["active", "closed"] } }, orderBy: [{ state: "asc" }, { startAt: "desc" }] });
  if (!s || s.projectId !== p.id || !s.startAt) return { sprint: null, points: [] as { day: string; remaining: number; ideal: number; issues: number }[] };
  const end = s.completedAt ?? s.endAt ?? new Date();
  const scope = await db.task.findMany({ where: { OR: [{ sprintId: s.id }, { id: { in: ((s.stats as { start?: { ids?: string[] } }).start?.ids ?? []) } }], parentId: null }, select: { id: true, points: true, completedAt: true } });
  const total = scope.reduce((a, t) => a + (t.points ?? 1), 0);
  const ds = days(s.startAt, end);
  return {
    sprint: { id: s.id, name: s.name, state: s.state, startAt: s.startAt, endAt: s.endAt, unit: scope.some((t) => t.points) ? "points" : "issues" },
    points: ds.map((d, i) => {
      const at = new Date(`${d}T23:59:59Z`);
      const left = scope.filter((t) => !t.completedAt || t.completedAt > at);
      return { day: d, remaining: left.reduce((a, t) => a + (t.points ?? 1), 0), issues: left.length, ideal: Math.round((total - (total * i) / Math.max(1, ds.length - 1)) * 10) / 10 };
    }),
  };
}

/** Velocity: committed vs completed for the last closed sprints. */
export async function velocity(me: Me, projectId: string) {
  await loadProject(me, projectId);
  const ss = await db.sprint.findMany({ where: { projectId, state: "closed" }, orderBy: { completedAt: "desc" }, take: 8 });
  return ss.reverse().map((s) => {
    const st = s.stats as { start?: { points: number; issues: number }; end?: { donePoints: number; doneIssues: number } };
    return { id: s.id, name: s.name, committed: st.start?.points ?? 0, completed: st.end?.donePoints ?? 0, committedIssues: st.start?.issues ?? 0, completedIssues: st.end?.doneIssues ?? 0 };
  });
}

/** Created vs resolved per day, and a cumulative flow of open issues by status group, over the last N days. */
export async function flow(me: Me, projectId: string, n = 30) {
  const p = await loadProject(me, projectId);
  const from = new Date(Date.now() - (n - 1) * 86_400_000);
  const rows = await db.task.findMany({ where: { projectId, parentId: null }, select: { id: true, createdAt: true, completedAt: true, status: true } });
  const changes = await db.taskActivity.findMany({ where: { task: { projectId }, field: "status" }, orderBy: { createdAt: "asc" }, select: { taskId: true, createdAt: true, to: true } });
  const nameToCat = new Map(workflow(p).map((s) => [s.name, s.category]));
  const cat = (id: string) => workflow(p).find((s) => s.id === id)?.category ?? "todo";
  const byTask = new Map<string, typeof changes>();
  for (const c of changes) byTask.set(c.taskId, [...(byTask.get(c.taskId) ?? []), c]);
  // Where each issue stood at the end of a day: done once resolved, else its last status change, else where it is now.
  const at = (t: (typeof rows)[number], end: Date): "todo" | "doing" | "done" => {
    if (t.completedAt && t.completedAt <= end) return "done";
    const hist = (byTask.get(t.id) ?? []).filter((c) => c.createdAt <= end);
    if (hist.length) {
      const c = nameToCat.get(hist[hist.length - 1].to ?? "") ?? "todo";
      return c === "done" ? "doing" : c;
    }
    if (byTask.has(t.id)) return "todo";
    const now = cat(t.status);
    return now === "done" ? "doing" : now;
  };
  return days(from, new Date()).map((d) => {
    const end = new Date(`${d}T23:59:59Z`);
    const start = new Date(`${d}T00:00:00Z`);
    const counts = { todo: 0, doing: 0, done: 0 };
    for (const t of rows) if (t.createdAt <= end) counts[at(t, end)]++;
    return {
      day: d,
      created: rows.filter((t) => t.createdAt >= start && t.createdAt <= end).length,
      resolved: rows.filter((t) => t.completedAt && t.completedAt >= start && t.completedAt <= end).length,
      ...counts,
    };
  });
}

/** Workload: open issues and points per person. */
export async function workload(me: Me, projectId: string) {
  await loadProject(me, projectId);
  const rows = await db.task.groupBy({ by: ["assigneeId"], where: { projectId, completedAt: null, parentId: null }, _count: true, _sum: { points: true } });
  return rows.map((r) => ({ assigneeId: r.assigneeId, issues: r._count, points: r._sum.points ?? 0 }));
}

// ── Saved filters ──────────────────────────────────────────────────────────

export async function listFilters(me: Me) {
  return db.taskFilter.findMany({ where: { ws: me.ws, OR: [{ userId: me.userId }, { shared: true }] }, orderBy: { createdAt: "asc" } });
}
export async function saveFilter(me: Me, b: { id?: string; name?: string; query?: TaskQuery; shared?: boolean }) {
  const name = str(b.name, 80);
  if (!name) bad("Name the filter.");
  const query = JSON.parse(JSON.stringify(b.query ?? {})) as object;
  if (b.id) {
    const f = await db.taskFilter.findUnique({ where: { id: b.id } });
    if (!f || f.ws !== me.ws || f.userId !== me.userId) throw new HttpError(404, "Filter not found");
    return db.taskFilter.update({ where: { id: f.id }, data: { name, query, shared: !!b.shared } });
  }
  return db.taskFilter.create({ data: { ws: me.ws, userId: me.userId, name, query, shared: !!b.shared } });
}
export async function deleteFilter(me: Me, id: string) {
  const f = await db.taskFilter.findUnique({ where: { id } });
  if (!f || f.ws !== me.ws || f.userId !== me.userId) throw new HttpError(404, "Filter not found");
  await db.taskFilter.delete({ where: { id } });
  return { ok: true };
}

// ── Automation rules ───────────────────────────────────────────────────────

const ON = ["created", "status", "assigned"];
const DO = ["assign", "status", "label", "comment", "notify"];

export async function listRules(me: Me, projectId: string) {
  await loadProject(me, projectId);
  return db.taskRule.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
}
export async function saveRule(me: Me, projectId: string, b: { id?: string; name?: string; trigger?: { on?: string; status?: string }; actions?: { do?: string; value?: string }[]; enabled?: boolean }) {
  const p = await loadProject(me, projectId, { write: true });
  if (p.myRole !== "admin" && p.createdBy !== me.userId && !me.owner) throw new HttpError(403, "Only a project admin can change automation.");
  const name = str(b.name, 100);
  if (!name) bad("Name the rule.");
  if (!ON.includes(String(b.trigger?.on))) bad("Pick when the rule runs: created, status change or assigned.");
  if (b.trigger?.status && !workflow(p).some((s) => s.id === b.trigger!.status)) bad("That status isn't in the workflow.");
  const actions = (b.actions ?? []).filter((a) => DO.includes(String(a.do))).slice(0, 5).map((a) => ({ do: String(a.do), value: str(a.value, 2000) }));
  if (!actions.length) bad("Add at least one thing for the rule to do.");
  const data = { name, trigger: { on: b.trigger!.on, ...(b.trigger?.status ? { status: b.trigger.status } : {}) }, actions, enabled: b.enabled !== false };
  if (b.id) {
    const r = await db.taskRule.findUnique({ where: { id: b.id } });
    if (!r || r.projectId !== projectId) throw new HttpError(404, "Rule not found");
    return db.taskRule.update({ where: { id: r.id }, data });
  }
  return db.taskRule.create({ data: { projectId, createdBy: me.userId, ...data } });
}
export async function deleteRule(me: Me, projectId: string, id: string) {
  const p = await loadProject(me, projectId, { write: true });
  if (p.myRole !== "admin" && p.createdBy !== me.userId && !me.owner) throw new HttpError(403, "Only a project admin can change automation.");
  await db.taskRule.deleteMany({ where: { id, projectId } });
  return { ok: true };
}

// ── Repeating issues ───────────────────────────────────────────────────────

type Recur = { every: "day" | "week" | "month"; interval: number; weekdays?: number[] };

export function nextRun(from: Date, r: Recur) {
  const d = new Date(from);
  if (r.every === "day") d.setUTCDate(d.getUTCDate() + r.interval);
  else if (r.every === "month") d.setUTCMonth(d.getUTCMonth() + r.interval);
  else {
    const wd = r.weekdays?.length ? [...r.weekdays].sort() : [d.getUTCDay()];
    for (let i = 1; i <= 7 * r.interval + 7; i++) {
      const c = new Date(from.getTime() + i * 86_400_000);
      const weeks = Math.floor((i + from.getUTCDay()) / 7);
      if (wd.includes(c.getUTCDay()) && (weeks % r.interval === 0 || r.interval === 1)) return c;
    }
    d.setUTCDate(d.getUTCDate() + 7 * r.interval);
  }
  return d;
}

export async function listRecurring(me: Me, projectId: string) {
  await loadProject(me, projectId);
  return db.taskRecurrence.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
}
export async function saveRecurring(me: Me, projectId: string, b: { id?: string; template?: Record<string, unknown>; rule?: Partial<Recur>; startAt?: string; enabled?: boolean }) {
  await loadProject(me, projectId, { write: true });
  const title = str(b.template?.title, 300);
  if (!title) bad("A repeating issue needs a title.");
  const every = (["day", "week", "month"] as const).find((e) => e === b.rule?.every);
  if (!every) bad("Repeat every day, week or month.");
  const rule: Recur = { every, interval: Math.max(1, Math.min(12, Math.round(Number(b.rule?.interval) || 1))), ...(every === "week" && b.rule?.weekdays?.length ? { weekdays: b.rule.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) } : {}) };
  const template = {
    title, description: str(b.template?.description, 5000), type: ["task", "bug", "story"].includes(String(b.template?.type)) ? String(b.template!.type) : "task",
    priority: Number(b.template?.priority ?? 1), assigneeId: typeof b.template?.assigneeId === "string" ? b.template.assigneeId : null, labels: Array.isArray(b.template?.labels) ? (b.template!.labels as unknown[]).map(String) : [],
    dueInDays: b.template?.dueInDays == null || b.template.dueInDays === "" ? null : Math.max(0, Math.min(365, Number(b.template.dueInDays) || 0)),
  };
  const nextAt = b.startAt ? new Date(b.startAt) : new Date();
  if (b.id) {
    const r = await db.taskRecurrence.findUnique({ where: { id: b.id } });
    if (!r || r.projectId !== projectId) throw new HttpError(404, "Not found");
    return db.taskRecurrence.update({ where: { id: r.id }, data: { template, rule, enabled: b.enabled !== false, ...(b.startAt ? { nextAt } : {}) } });
  }
  return db.taskRecurrence.create({ data: { projectId, template, rule, nextAt, createdBy: me.userId } });
}
export async function deleteRecurring(me: Me, projectId: string, id: string) {
  await loadProject(me, projectId, { write: true });
  await db.taskRecurrence.deleteMany({ where: { id, projectId } });
  return { ok: true };
}

/** Background job: make the issues whose time has come, as the person who set them up. */
export async function recurringTick(now = new Date()) {
  const due = await db.taskRecurrence.findMany({ where: { enabled: true, nextAt: { lte: now } }, take: 100 });
  for (const r of due) {
    try {
      const p = await db.project.findUnique({ where: { id: r.projectId } });
      const author = await db.user.findUnique({ where: { id: r.createdBy } });
      if (!p || p.archived || !author) continue;
      const me = { sid: "job", userId: author.id, ws: p.ws, name: author.name ?? "", email: author.email, tz: author.tz ?? "UTC", owner: false, perms: { "tasks.assign": true, "tasks.open": true, "tasks.create": true } } as unknown as Me;
      const t = r.template as Record<string, unknown>;
      const dueDay = t.dueInDays == null ? null : new Date(now.getTime() + Number(t.dueInDays) * 86_400_000).toISOString().slice(0, 10);
      await createTask(me, { projectId: p.id, title: String(t.title), description: String(t.description ?? ""), type: String(t.type ?? "task"), priority: Number(t.priority ?? 1), assigneeId: (t.assigneeId as string) || null, labels: (t.labels as string[]) ?? [], due: dueDay }).catch(async () =>
        createTask(me, { projectId: p.id, title: String(t.title), type: String(t.type ?? "task"), due: dueDay }),
      );
      let next = nextRun(r.nextAt, r.rule as unknown as Recur);
      while (next <= now) next = nextRun(next, r.rule as unknown as Recur);
      await db.taskRecurrence.update({ where: { id: r.id }, data: { nextAt: next } });
    } catch (e) {
      console.error("recurring task", e);
    }
  }
  return due.length;
}

/** Background job: a heads-up the day before something is due, once. */
export async function dueSoonTick(now = new Date()) {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const rows = await db.task.findMany({ where: { due: tomorrow, completedAt: null, assigneeId: { not: null } }, include: { project: true }, take: 500 });
  for (const t of rows)
    await notify({ ws: t.ws, userId: t.assigneeId!, kind: "task.due", title: `Due tomorrow: ${t.project.key}-${t.number} ${t.title}`.slice(0, 200), link: `/tasks?project=${t.projectId}&task=${t.id}`, key: `task-due:${t.id}:${tomorrow.toISOString().slice(0, 10)}` }).catch(() => null);
}

// ── Attachments ────────────────────────────────────────────────────────────

const FILES = path.join(process.cwd(), "storage", "task-files");
const MAX = 25 * 1024 * 1024;

export async function addAttachment(me: Me, taskId: string, file: File) {
  const t = await loadTask(me, taskId, { write: true });
  if (!file || !file.size) bad("Choose a file.");
  if (file.size > MAX) bad("Files can be up to 25 MB.");
  if ((await db.taskAttachment.count({ where: { taskId: t.id } })) >= 50) bad("An issue can have up to 50 files.");
  const id = crypto.randomUUID();
  const safe = (file.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const rel = path.join(t.id, `${id}-${safe}`);
  await fs.mkdir(path.join(FILES, t.id), { recursive: true });
  await fs.writeFile(path.join(FILES, rel), Buffer.from(await file.arrayBuffer()));
  const a = await db.taskAttachment.create({ data: { taskId: t.id, name: safe, type: file.type || "application/octet-stream", size: file.size, path: rel, userId: me.userId } });
  await db.taskActivity.create({ data: { taskId: t.id, userId: me.userId, kind: "attachment", to: safe } });
  changed(me, t.projectId, [t.id]);
  return a;
}

export async function readAttachment(me: Me, id: string) {
  const a = await db.taskAttachment.findUnique({ where: { id } });
  if (!a) throw new HttpError(404, "File not found");
  await loadTask(me, a.taskId);
  const full = path.join(FILES, a.path);
  if (!full.startsWith(FILES)) throw new HttpError(404, "File not found");
  return { a, data: await fs.readFile(full) };
}

export async function deleteAttachment(me: Me, id: string) {
  const a = await db.taskAttachment.findUnique({ where: { id } });
  if (!a) throw new HttpError(404, "File not found");
  const t = await loadTask(me, a.taskId, { write: true });
  await db.taskAttachment.delete({ where: { id } });
  await fs.rm(path.join(FILES, a.path), { force: true });
  changed(me, t.projectId, [t.id]);
  return { ok: true };
}

// ── CSV ────────────────────────────────────────────────────────────────────

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

export async function exportCsv(me: Me, q: TaskQuery) {
  const rows = await listTasks(me, { ...q, subtasks: true });
  const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.assigneeId, r.createdBy]).filter(Boolean) as string[])] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.email]));
  const projects = new Map((await db.project.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } } })).map((p) => [p.id, p]));
  // One project: its custom fields get their own columns.
  const defs = q.projectId ? ((projects.get(q.projectId)?.fieldDefs as { id: string; name: string; type: string }[] | undefined) ?? []) : [];
  const head = ["Key", "Type", "Title", "Status", "Priority", "Assignee", "Reporter", "Labels", "Start", "Due", "Story points", "Estimate (min)", "Logged (min)", "Created", "Resolved", "Description", ...defs.map((d) => d.name)];
  const lines = rows.map((r) => {
    const p = projects.get(r.projectId)!;
    const custom = defs.map((d) => {
      const v = r.custom?.[d.id];
      return v === undefined ? "" : d.type === "user" ? (users.get(String(v)) ?? "") : String(v);
    });
    return [r.key, r.type, r.title, workflow(p).find((s) => s.id === r.status)?.name ?? r.status, ["Low", "Normal", "High", "Urgent"][r.priority], users.get(r.assigneeId ?? "") ?? "", users.get(r.createdBy) ?? "", r.labels.join(";"), r.start ?? "", r.due ?? "", r.points ?? "", r.estimateMin ?? "", r.loggedMin, r.createdAt.toISOString(), r.completedAt?.toISOString() ?? "", r.description, ...custom]
      .map(csvCell)
      .join(",");
  });
  return [head.join(","), ...lines].join("\r\n");
}

/** Parse CSV (quotes, commas and newlines in cells). */
export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Import issues from CSV with a header row (Title required; Type, Status, Priority, Assignee email, Labels, Due, Story points, Description optional). */
export async function importCsv(me: Me, projectId: string, text: string) {
  const p = await loadProject(me, projectId, { write: true });
  const rows = parseCsv(text);
  if (rows.length < 2) bad("The file needs a header row and at least one issue.");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ix = { title: col("title", "summary"), type: col("type", "issue type"), status: col("status"), priority: col("priority"), assignee: col("assignee"), labels: col("labels"), due: col("due", "due date"), points: col("story points", "points"), description: col("description") };
  if (ix.title < 0) bad("Add a Title (or Summary) column.");
  const people = await db.user.findMany({ where: { id: { in: p.members.map((m) => m.userId) } }, select: { id: true, email: true, name: true } });
  const created: string[] = [];
  const errors: { row: number; error: string }[] = [];
  for (const [i, r] of rows.slice(1, 1001).entries()) {
    const get = (k: keyof typeof ix) => (ix[k] >= 0 ? (r[ix[k]] ?? "").trim() : "");
    const who = get("assignee").toLowerCase();
    const status = workflow(p).find((s) => s.name.toLowerCase() === get("status").toLowerCase() || s.id === get("status").toLowerCase());
    const pr = ["low", "normal", "high", "urgent"].indexOf(get("priority").toLowerCase());
    const type = get("type").toLowerCase();
    try {
      const t = await createTask(me, {
        projectId: p.id,
        title: get("title"),
        description: get("description"),
        type: ["task", "bug", "story", "epic"].includes(type) ? type : "task",
        ...(status ? { status: status.id } : {}),
        priority: pr >= 0 ? pr : 1,
        assigneeId: who ? (people.find((u) => u.email.toLowerCase() === who || u.name?.toLowerCase() === who)?.id ?? null) : null,
        labels: get("labels").split(/[;,]/).map((l) => l.trim()).filter(Boolean),
        due: /^\d{4}-\d{2}-\d{2}$/.test(get("due")) ? get("due") : null,
        points: get("points") ? Number(get("points")) : null,
      });
      created.push(t.id);
    } catch (e) {
      errors.push({ row: i + 2, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { created: created.length, errors };
}

/**
 * The company's default Tasks project ("General", key GEN): every workspace member is in it,
 * so a task can always be made without first choosing or creating a project.
 */
export async function defaultProject(me: Me) {
  let p = await db.project.findFirst({ where: { ws: me.ws, key: "GEN", archived: false } });
  if (!p) {
    const members = await db.member.findMany({ where: { ws: me.ws }, select: { userId: true } });
    const made = await createProject(me, { name: "General", key: "GEN", description: "Everyone's tasks that don't belong to a specific project.", memberIds: members.map((m) => m.userId) });
    p = await db.project.findUniqueOrThrow({ where: { id: made.id } });
  }
  await db.projectMember.upsert({ where: { projectId_userId: { projectId: p.id, userId: me.userId } }, create: { projectId: p.id, userId: me.userId, role: "member" }, update: {} });
  return p;
}
