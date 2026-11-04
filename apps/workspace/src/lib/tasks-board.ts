import { db } from "./db";
import { HttpError, type Me } from "./auth";
import { bad, str } from "./http";
import { changed, loadProject, workflow, type Status } from "./tasks";

/**
 * The board and project pages around Tasks: column changes made on the board,
 * releases (versions) and components, quick filters and features, the
 * project summary, and board insights (progress, breakdowns, work that needs
 * attention).
 */

const isAdmin = (me: Me, p: { createdBy: string; myRole: string }) => p.myRole === "admin" || p.createdBy === me.userId || me.owner;
const day = (v: unknown, what: string) => {
  if (v === null || v === "" || v === undefined) return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
  bad(`${what} must be YYYY-MM-DD.`);
};

// ── Columns ────────────────────────────────────────────────────────────────

/** Delete a column (status) after moving its issues to another one. */
export async function deleteColumn(me: Me, projectId: string, statusId: string, moveTo: string) {
  const p = await loadProject(me, projectId, { write: true });
  if (!isAdmin(me, p)) throw new HttpError(403, "Only a project admin can change the columns.");
  const wf = workflow(p);
  const gone = wf.find((s) => s.id === statusId);
  const to = wf.find((s) => s.id === moveTo);
  if (!gone) bad("That column isn't on the board.");
  if (!to || to.id === gone.id) bad("Pick another column for its issues.");
  const rest = wf.filter((s) => s.id !== statusId);
  if (rest.length < 2) bad("A board needs at least two columns.");
  if (!rest.some((s) => s.category === "todo") || !rest.some((s) => s.category === "done")) bad("Keep at least one To do and one Done column.");
  const now = new Date();
  const moved = await db.task.updateMany({ where: { projectId, status: statusId }, data: { status: to.id, statusAt: now, completedAt: to.category === "done" ? now : null } });
  await db.project.update({ where: { id: projectId }, data: { statuses: rest as never } });
  changed(me, projectId, []);
  return { moved: moved.count, statuses: rest };
}

// ── Releases ───────────────────────────────────────────────────────────────

export async function listVersions(me: Me, projectId: string) {
  const p = await loadProject(me, projectId);
  const versions = await db.version.findMany({ where: { projectId }, orderBy: [{ releaseDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }] });
  const counts = await db.task.groupBy({ by: ["versionId", "status"], where: { projectId, versionId: { in: versions.map((v) => v.id) } }, _count: true });
  const doneIds = new Set(workflow(p).filter((s) => s.category === "done").map((s) => s.id));
  const doingIds = new Set(workflow(p).filter((s) => s.category === "doing").map((s) => s.id));
  return versions.map((v) => {
    const mine = counts.filter((c) => c.versionId === v.id);
    const n = (f: (s: string) => boolean) => mine.filter((c) => f(c.status)).reduce((a, c) => a + c._count, 0);
    return { ...v, issues: n(() => true), done: n((s) => doneIds.has(s)), doing: n((s) => doingIds.has(s)) };
  });
}

export async function saveVersion(me: Me, projectId: string, b: Record<string, unknown>) {
  const p = await loadProject(me, projectId, { write: true });
  if (!isAdmin(me, p)) throw new HttpError(403, "Only a project admin can manage releases.");
  const name = str(b.name, 80);
  const data = {
    ...(b.name !== undefined ? { name } : {}),
    ...(b.description !== undefined ? { description: str(b.description, 2000) } : {}),
    ...(b.startDate !== undefined ? { startDate: day(b.startDate, "Start date") } : {}),
    ...(b.releaseDate !== undefined ? { releaseDate: day(b.releaseDate, "Release date") } : {}),
    ...(b.status === "archived" || b.status === "unreleased" ? { status: b.status, ...(b.status === "unreleased" ? { releasedAt: null } : {}) } : {}),
  };
  if (b.name !== undefined && !name) bad("Name the release, e.g. 2.4 or Spring launch.");
  if (typeof b.id === "string") {
    const v = await db.version.findUnique({ where: { id: b.id } });
    if (!v || v.projectId !== projectId) throw new HttpError(404, "Release not found");
    if (name && (await db.version.findFirst({ where: { projectId, name, id: { not: v.id } } }))) bad(`There's already a release called ${name}.`);
    return db.version.update({ where: { id: v.id }, data });
  }
  if (!name) bad("Name the release, e.g. 2.4 or Spring launch.");
  if (await db.version.findFirst({ where: { projectId, name } })) bad(`There's already a release called ${name}.`);
  return db.version.create({ data: { projectId, name, ...data } });
}

/** Release a version: unfinished issues move to another release or none. */
export async function releaseVersion(me: Me, projectId: string, id: string, moveTo: string | null) {
  const p = await loadProject(me, projectId, { write: true });
  if (!isAdmin(me, p)) throw new HttpError(403, "Only a project admin can release.");
  const v = await db.version.findUnique({ where: { id } });
  if (!v || v.projectId !== projectId) throw new HttpError(404, "Release not found");
  if (v.status === "released") bad("It's already released.");
  if (moveTo) {
    const t = await db.version.findUnique({ where: { id: moveTo } });
    if (!t || t.projectId !== projectId || t.status !== "unreleased" || t.id === id) bad("Move unfinished issues to another unreleased version.");
  }
  const doneIds = workflow(p).filter((s) => s.category === "done").map((s) => s.id);
  const moved = await db.task.updateMany({ where: { versionId: id, status: { notIn: doneIds } }, data: { versionId: moveTo } });
  const u = await db.version.update({ where: { id }, data: { status: "released", releasedAt: new Date(), releaseDate: v.releaseDate ?? new Date() } });
  changed(me, projectId, []);
  return { version: u, moved: moved.count };
}

export async function deleteVersion(me: Me, projectId: string, id: string) {
  const p = await loadProject(me, projectId, { write: true });
  if (!isAdmin(me, p)) throw new HttpError(403, "Only a project admin can manage releases.");
  await db.task.updateMany({ where: { projectId, versionId: id }, data: { versionId: null } });
  await db.version.deleteMany({ where: { id, projectId } });
  return { ok: true };
}

/** Release notes in Markdown, grouped by type. */
export async function releaseNotes(me: Me, projectId: string, id: string) {
  const p = await loadProject(me, projectId);
  const v = await db.version.findUnique({ where: { id } });
  if (!v || v.projectId !== projectId) throw new HttpError(404, "Release not found");
  const rows = await db.task.findMany({ where: { versionId: id, parentId: null }, orderBy: { number: "asc" } });
  const groups: [string, string][] = [["story", "New"], ["task", "Improvements"], ["bug", "Fixes"], ["epic", "Epics"]];
  const lines = [`# ${p.name} ${v.name}`, v.releaseDate ? `Released ${v.releaseDate.toISOString().slice(0, 10)}` : "", v.description, ""];
  for (const [type, title] of groups) {
    const items = rows.filter((r) => r.type === type);
    if (!items.length) continue;
    lines.push(`## ${title}`, ...items.map((r) => `- ${p.key}-${r.number} ${r.title}`), "");
  }
  return lines.filter((l, i) => l || lines[i - 1]).join("\n").trim();
}

// ── Components ─────────────────────────────────────────────────────────────

export async function listComponents(me: Me, projectId: string) {
  await loadProject(me, projectId);
  const cs = await db.component.findMany({ where: { projectId }, orderBy: { name: "asc" } });
  const counts = await db.task.findMany({ where: { projectId, componentIds: { hasSome: cs.map((c) => c.id) } }, select: { componentIds: true } });
  return cs.map((c) => ({ ...c, issues: counts.filter((t) => t.componentIds.includes(c.id)).length }));
}
export async function saveComponent(me: Me, projectId: string, b: Record<string, unknown>) {
  const p = await loadProject(me, projectId, { write: true });
  if (!isAdmin(me, p)) throw new HttpError(403, "Only a project admin can manage components.");
  const name = str(b.name, 60);
  if (!name) bad("Name the component, e.g. Checkout or Mobile app.");
  const leadId = typeof b.leadId === "string" && b.leadId && p.members.some((m) => m.userId === b.leadId) ? b.leadId : null;
  const data = { name, description: str(b.description, 1000), leadId };
  if (typeof b.id === "string") {
    const c = await db.component.findUnique({ where: { id: b.id } });
    if (!c || c.projectId !== projectId) throw new HttpError(404, "Component not found");
    return db.component.update({ where: { id: c.id }, data });
  }
  if (await db.component.findFirst({ where: { projectId, name } })) bad(`There's already a component called ${name}.`);
  return db.component.create({ data: { projectId, ...data } });
}
export async function deleteComponent(me: Me, projectId: string, id: string) {
  const p = await loadProject(me, projectId, { write: true });
  if (!isAdmin(me, p)) throw new HttpError(403, "Only a project admin can manage components.");
  const rows = await db.task.findMany({ where: { projectId, componentIds: { has: id } }, select: { id: true, componentIds: true } });
  for (const r of rows) await db.task.update({ where: { id: r.id }, data: { componentIds: r.componentIds.filter((x) => x !== id) } });
  await db.component.deleteMany({ where: { id, projectId } });
  return { ok: true };
}

// ── Summary and insights ───────────────────────────────────────────────────

/** The project's front page: what happened lately and where the work stands. */
export async function summary(me: Me, projectId: string) {
  const p = await loadProject(me, projectId);
  const week = new Date(Date.now() - 7 * 86_400_000);
  const soon = new Date(Date.now() + 7 * 86_400_000);
  const rows = await db.task.findMany({ where: { projectId }, select: { id: true, number: true, title: true, type: true, status: true, priority: true, assigneeId: true, epicId: true, createdAt: true, updatedAt: true, completedAt: true, due: true, points: true } });
  const activity = await db.taskActivity.findMany({ where: { task: { projectId } }, orderBy: { createdAt: "desc" }, take: 20, include: { task: { select: { id: true, number: true, title: true } } } });
  const wf = workflow(p);
  const count = <K extends string>(xs: K[]) => xs.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {});
  const epics = rows.filter((r) => r.type === "epic");
  return {
    counts: {
      created: rows.filter((r) => r.createdAt > week).length,
      updated: rows.filter((r) => r.updatedAt > week).length,
      completed: rows.filter((r) => r.completedAt && r.completedAt > week).length,
      dueSoon: rows.filter((r) => r.due && !r.completedAt && r.due <= soon).length,
    },
    status: wf.map((s) => ({ id: s.id, name: s.name, color: s.color, category: s.category, n: rows.filter((r) => r.status === s.id && r.type !== "epic").length })),
    priority: [0, 1, 2, 3].map((n) => ({ priority: n, n: rows.filter((r) => r.priority === n && !r.completedAt).length })),
    types: Object.entries(count(rows.map((r) => r.type))).map(([type, n]) => ({ type, n })),
    workload: Object.entries(count(rows.filter((r) => !r.completedAt && r.type !== "epic").map((r) => r.assigneeId ?? "none"))).map(([assigneeId, n]) => ({ assigneeId: assigneeId === "none" ? null : assigneeId, n })).sort((a, b) => b.n - a.n),
    epics: epics.map((e) => {
      const kids = rows.filter((r) => r.epicId === e.id);
      return { id: e.id, key: `${p.key}-${e.number}`, title: e.title, total: kids.length, done: kids.filter((k) => k.completedAt).length };
    }),
    activity: activity.map((a) => ({ id: a.id, userId: a.userId, kind: a.kind, field: a.field, to: a.to, createdAt: a.createdAt, task: { id: a.task.id, key: `${p.key}-${a.task.number}`, title: a.task.title } })),
  };
}

/** Board insights: the running sprint's progress, type and epic breakdown, and work that needs attention. */
export async function insights(me: Me, projectId: string) {
  const p = await loadProject(me, projectId);
  const wf = workflow(p);
  const cat = (s: string) => wf.find((x) => x.id === s)?.category ?? "todo";
  const sprint = await db.sprint.findFirst({ where: { projectId, state: "active" } });
  const scope = await db.task.findMany({
    // No sprint running (Kanban): open work plus what was finished in the last 14 days.
    where: { projectId, parentId: null, type: { not: "epic" }, ...(sprint ? { sprintId: sprint.id } : { OR: [{ completedAt: null }, { completedAt: { gt: new Date(Date.now() - 14 * 86_400_000) } }] }) },
    select: { id: true, number: true, title: true, type: true, status: true, points: true, epicId: true, flagged: true, statusAt: true, completedAt: true },
  });
  const blockers = await db.taskLink.findMany({ where: { kind: "blocks", toId: { in: scope.map((t) => t.id) } }, include: { from: { select: { completedAt: true } } } });
  const stuckDays = 5;
  const stuckBefore = new Date(Date.now() - stuckDays * 86_400_000);
  const pts = (xs: typeof scope) => xs.reduce((a, t) => a + (t.points ?? 0), 0);
  const by = (c: string) => scope.filter((t) => cat(t.status) === c);
  const epicIds = [...new Set(scope.map((t) => t.epicId).filter(Boolean) as string[])];
  const epics = await db.task.findMany({ where: { id: { in: epicIds } }, select: { id: true, number: true, title: true } });
  const item = (t: (typeof scope)[number]) => ({ id: t.id, key: `${p.key}-${t.number}`, title: t.title });
  return {
    sprint: sprint ? { id: sprint.id, name: sprint.name, goal: sprint.goal, endAt: sprint.endAt, daysLeft: sprint.endAt ? Math.max(0, Math.ceil((sprint.endAt.getTime() - Date.now()) / 86_400_000)) : null } : null,
    progress: { todo: by("todo").length, doing: by("doing").length, done: by("done").length, pointsTodo: pts(by("todo")), pointsDoing: pts(by("doing")), pointsDone: pts(by("done")) },
    types: ["story", "task", "bug"].map((type) => ({ type, total: scope.filter((t) => t.type === type).length, done: scope.filter((t) => t.type === type && cat(t.status) === "done").length })),
    epics: epics.map((e) => ({ id: e.id, key: `${p.key}-${e.number}`, title: e.title, total: scope.filter((t) => t.epicId === e.id).length, done: scope.filter((t) => t.epicId === e.id && cat(t.status) === "done").length })),
    attention: {
      stuckDays,
      stuck: scope.filter((t) => cat(t.status) === "doing" && t.statusAt < stuckBefore).map(item),
      blocked: scope.filter((t) => cat(t.status) !== "done" && blockers.some((b) => b.toId === t.id && !b.from.completedAt)).map(item),
      flagged: scope.filter((t) => t.flagged && cat(t.status) !== "done").map(item),
    },
  };
}

// ── Quick filters and features ─────────────────────────────────────────────

export function cleanQuickFilters(input: unknown) {
  if (!Array.isArray(input)) bad("Quick filters are a list.");
  return (input as Record<string, unknown>[]).slice(0, 20).map((q, i) => {
    const name = str(q.name, 40);
    const query = str(q.query, 1000);
    if (!name || !query) bad("Each quick filter needs a name and a query.");
    return { id: typeof q.id === "string" && q.id ? q.id.slice(0, 40) : `qf_${Date.now().toString(36)}${i}`, name, query };
  });
}

export function cleanFeatures(input: unknown) {
  const b = (input ?? {}) as Record<string, unknown>;
  return {
    sprints: b.sprints !== false,
    releases: b.releases !== false,
    components: b.components !== false,
    estimation: b.estimation === "time" ? "time" : "points",
  };
}

export type { Status };
