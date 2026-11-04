import type { Prisma, Project, Task } from "@prisma/client";
import { db } from "./db";
import { can, HttpError, type Me } from "./auth";
import { notify } from "./notify";
import { publish } from "./bus";
import { bad } from "./http";
import { cleanCustom, parseQuery, QueryError, type FieldDef } from "./tasks-fields";

/**
 * Tasks: projects with an issue key (ENG-12), issue types and epics, a
 * workflow of your own statuses with WIP limits, sprints and a backlog,
 * subtasks, links between issues, watchers, estimates and time logs, labels,
 * attachments, comments with @mentions, and a history of every change.
 * "Done" is whatever status sits in the done category; completedAt marks it,
 * so other apps (Calendar, AI planning) ask completedAt, not the status id.
 */

// ── Workflow ───────────────────────────────────────────────────────────────

export type Status = { id: string; name: string; category: "todo" | "doing" | "done"; color: string; wip: number | null; min?: number | null };
export const DEFAULT_STATUSES: Status[] = [
  { id: "todo", name: "To do", category: "todo", color: "#64748b", wip: null },
  { id: "doing", name: "In progress", category: "doing", color: "#2563eb", wip: null },
  { id: "review", name: "In review", category: "doing", color: "#9333ea", wip: null },
  { id: "done", name: "Done", category: "done", color: "#16a34a", wip: null },
];
export const TYPES = ["task", "bug", "story", "epic", "subtask"] as const;
export type IssueType = (typeof TYPES)[number];
export const LINK_KINDS: Record<string, [string, string]> = {
  blocks: ["blocks", "is blocked by"],
  relates: ["relates to", "relates to"],
  duplicates: ["duplicates", "is duplicated by"],
  clones: ["clones", "is cloned by"],
};

export function workflow(p: Pick<Project, "statuses">): Status[] {
  const s = Array.isArray(p.statuses) ? (p.statuses as unknown as Status[]) : [];
  return s.length ? s : DEFAULT_STATUSES;
}
const isDone = (p: Pick<Project, "statuses">, status: string) => workflow(p).find((s) => s.id === status)?.category === "done";
const statusName = (p: Pick<Project, "statuses">, id: string) => workflow(p).find((s) => s.id === id)?.name ?? id;

/** A workflow from the editor: 2-12 statuses, ids kept for existing ones, at least one to-do and one done. */
export function cleanWorkflow(input: unknown, used: Set<string>): Status[] {
  if (!Array.isArray(input)) bad("The workflow is a list of statuses.");
  const out: Status[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, 12) as Record<string, unknown>[]) {
    const name = String(raw.name ?? "").trim().slice(0, 30);
    if (!name) bad("Every status needs a name.");
    const category = (["todo", "doing", "done"] as const).find((c) => c === raw.category) ?? "doing";
    let id = typeof raw.id === "string" && /^[a-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "status";
    while (seen.has(id)) id = `${id}_2`;
    seen.add(id);
    const wip = raw.wip == null || raw.wip === "" ? null : Math.max(1, Math.min(999, Math.round(Number(raw.wip)) || 1));
    const min = raw.min == null || raw.min === "" ? null : Math.max(0, Math.min(999, Math.round(Number(raw.min)) || 0));
    if (wip != null && min != null && min > wip) bad(`${name}: the minimum is above the maximum.`);
    out.push({ id, name, category, color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : "#64748b", wip: category === "done" ? null : wip, min: category === "done" ? null : min });
  }
  if (out.length < 2) bad("A workflow needs at least two statuses.");
  if (!out.some((s) => s.category === "todo")) bad("Keep at least one status in the To do group.");
  if (!out.some((s) => s.category === "done")) bad("Keep at least one status in the Done group.");
  const gone = [...used].filter((u) => !seen.has(u));
  if (gone.length) bad(`Issues still use ${gone.join(", ")}. Move them to another status first.`);
  return out;
}

// ── Keys ───────────────────────────────────────────────────────────────────

/** "Website relaunch" -> "WR"; "Engineering" -> "ENG". */
export function suggestKey(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const k = words.length >= 2 ? words.map((w) => w[0]).join("") : (words[0] ?? "PRJ").slice(0, 3);
  return (/^[A-Z]/.test(k) ? k : `P${k}`).slice(0, 6) || "PRJ";
}
export async function uniqueKey(ws: string, want: string, exceptId?: string) {
  const base = want.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(base)) bad("A project key is 2-8 letters or digits, starting with a letter.");
  let k = base;
  for (let i = 2; ; i++) {
    const clash = await db.project.findFirst({ where: { ws, key: k, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (!clash) return k;
    k = `${base.slice(0, 6)}${i}`;
  }
}

/** Projects made before keys existed get one, and their issues get numbers, the first time they're used. */
export async function ensureKeys(p: Project) {
  if (p.key) return p;
  const key = await uniqueKey(p.ws, suggestKey(p.name));
  const tasks = await db.task.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
  await db.$transaction([...tasks.map((t, i) => db.task.update({ where: { id: t.id }, data: { number: i + 1 } })), db.project.update({ where: { id: p.id }, data: { key, nextNumber: tasks.length + 1 } })]);
  return { ...p, key, nextNumber: tasks.length + 1 };
}

async function nextNumber(projectId: string) {
  const p = await db.project.update({ where: { id: projectId }, data: { nextNumber: { increment: 1 } }, select: { nextNumber: true } });
  return p.nextNumber - 1;
}

// ── Access ─────────────────────────────────────────────────────────────────

const today = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

/** A project I'm a member of in my workspace, else 404. Viewers can read but not change. */
export async function loadProject(me: Me, id: string, opts: { write?: boolean } = {}) {
  const p0 = await db.project.findUnique({ where: { id }, include: { members: true } });
  const mine = p0?.members.find((m) => m.userId === me.userId);
  if (!p0 || p0.ws !== me.ws || !mine) throw new HttpError(404, "Project not found");
  if (opts.write && mine.role === "viewer") throw new HttpError(403, "You can view this project but not change it.");
  const p = await ensureKeys(p0);
  return { ...p0, ...p, myRole: mine.role };
}

export async function loadTask(me: Me, idOrKey: string, opts: { write?: boolean } = {}) {
  let t = await db.task.findUnique({ where: { id: idOrKey }, include: { project: { include: { members: true } } } });
  if (!t) {
    const m = /^([A-Z][A-Z0-9]{1,7})-(\d+)$/.exec(idOrKey.toUpperCase());
    if (m) {
      const p = await db.project.findFirst({ where: { ws: me.ws, key: m[1] }, select: { id: true } });
      if (p) t = await db.task.findFirst({ where: { projectId: p.id, number: Number(m[2]) }, include: { project: { include: { members: true } } } });
    }
  }
  const mine = t?.project.members.find((m) => m.userId === me.userId);
  if (!t || t.ws !== me.ws || !mine) throw new HttpError(404, "Task not found");
  if (opts.write && mine.role === "viewer") throw new HttpError(403, "You can view this project but not change it.");
  if (!t.project.key) t.project = { ...t.project, ...(await ensureKeys(t.project)) };
  return t;
}

// ── Shape sent to the browser ──────────────────────────────────────────────

type Counts = { comments: number; attachments: number };
type Extra = { subs?: { total: number; done: number }; logged?: number; links?: number; blocks?: string[]; coverId?: string | null };

export function taskDto(t: Task & { _count?: Partial<Counts> }, p: Pick<Project, "key" | "statuses">, x: Extra = {}) {
  return {
    id: t.id,
    key: `${p.key ?? "TASK"}-${t.number}`,
    number: t.number,
    projectId: t.projectId,
    type: t.type,
    parentId: t.parentId,
    epicId: t.epicId,
    sprintId: t.sprintId,
    title: t.title,
    description: t.description,
    status: t.status,
    done: isDone(p, t.status),
    priority: t.priority,
    assigneeId: t.assigneeId,
    watchers: t.watchers,
    start: t.start ? t.start.toISOString().slice(0, 10) : null,
    due: t.due ? t.due.toISOString().slice(0, 10) : null,
    overdue: !!t.due && !isDone(p, t.status) && t.due < today(),
    points: t.points,
    estimateMin: t.estimateMin,
    loggedMin: x.logged ?? 0,
    labels: t.labels,
    custom: (t.custom ?? {}) as Record<string, string | number | boolean>,
    flagged: t.flagged,
    flagNote: t.flagNote,
    versionId: t.versionId,
    componentIds: t.componentIds,
    statusAt: t.statusAt,
    checklist: t.checklist as { text: string; done: boolean }[],
    links: t.links as { url: string; title: string }[],
    position: t.position,
    createdBy: t.createdBy,
    messageId: t.messageId,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    comments: t._count?.comments ?? 0,
    attachments: t._count?.attachments ?? 0,
    issueLinks: x.links ?? 0,
    blocks: x.blocks ?? [],
    coverId: x.coverId ?? null,
    subtasks: x.subs ?? { total: 0, done: 0 },
  };
}
export type TaskDto = ReturnType<typeof taskDto>;

const COUNT = { _count: { select: { comments: true, attachments: true } } } as const;

async function decorate(rows: (Task & { _count: Counts })[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const projects = await db.project.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } } });
  const proj = new Map(projects.map((p) => [p.id, p]));
  const [subs, logs, linkA, linkB] = await Promise.all([
    db.task.findMany({ where: { parentId: { in: ids } }, select: { parentId: true, status: true, projectId: true } }),
    db.taskWorklog.groupBy({ by: ["taskId"], where: { taskId: { in: ids } }, _sum: { minutes: true } }),
    db.taskLink.groupBy({ by: ["fromId"], where: { fromId: { in: ids } }, _count: true }),
    db.taskLink.groupBy({ by: ["toId"], where: { toId: { in: ids } }, _count: true }),
  ]);
  const [blocking, covers] = await Promise.all([
    db.taskLink.findMany({ where: { fromId: { in: ids }, kind: "blocks" }, select: { fromId: true, toId: true } }),
    db.taskAttachment.findMany({ where: { taskId: { in: ids }, type: { in: ["image/png", "image/jpeg", "image/gif", "image/webp"] } }, orderBy: { createdAt: "asc" }, select: { id: true, taskId: true } }),
  ]);
  return rows.map((r) => {
    const p = proj.get(r.projectId)!;
    const mine = subs.filter((s) => s.parentId === r.id);
    return taskDto(r, p, {
      subs: { total: mine.length, done: mine.filter((s) => isDone(p, s.status)).length },
      logged: logs.find((l) => l.taskId === r.id)?._sum.minutes ?? 0,
      links: (linkA.find((l) => l.fromId === r.id)?._count ?? 0) + (linkB.find((l) => l.toId === r.id)?._count ?? 0),
      blocks: blocking.filter((b) => b.fromId === r.id).map((b) => b.toId),
      coverId: covers.find((c) => c.taskId === r.id)?.id ?? null,
    });
  });
}

// ── Search ─────────────────────────────────────────────────────────────────

export type TaskQuery = {
  /** The query language, e.g. assignee = me AND status != Done ORDER BY due. */
  q?: string;
  projectId?: string;
  mine?: boolean;
  parentId?: string;
  /** Subtasks are left out of lists unless asked for. */
  subtasks?: boolean;
  text?: string;
  assignee?: string; // a user id, "me" or "none"
  reporter?: string;
  type?: string;
  status?: string; // a status id, or a category: "category:todo"
  priority?: number;
  label?: string;
  sprint?: string; // a sprint id, "backlog" or "active"
  epic?: string; // an epic id or "none"
  due?: "overdue" | "today" | "week" | "none";
  watching?: boolean;
  open?: boolean;
  updatedSince?: string;
  sort?: "rank" | "key" | "updated" | "created" | "due" | "priority" | "title" | "status";
  dir?: "asc" | "desc";
};

export function queryFromParams(q: URLSearchParams): TaskQuery {
  const g = (k: string) => q.get(k) || undefined;
  return {
    q: g("q"),
    projectId: g("projectId"),
    mine: q.get("mine") === "1",
    parentId: g("parentId"),
    subtasks: q.get("subtasks") === "1",
    text: g("text"),
    assignee: g("assignee"),
    reporter: g("reporter"),
    type: g("type"),
    status: g("status"),
    priority: q.get("priority") ? Number(q.get("priority")) : undefined,
    label: g("label"),
    sprint: g("sprint"),
    epic: g("epic"),
    due: g("due") as TaskQuery["due"],
    watching: q.get("watching") === "1",
    open: q.get("open") === "1",
    updatedSince: g("updatedSince"),
    sort: g("sort") as TaskQuery["sort"],
    dir: g("dir") as TaskQuery["dir"],
  };
}

/** Run a query-language search over the projects I am in. */
export async function searchQuery(me: Me, text: string) {
  const projects = await db.project.findMany({ where: { ws: me.ws, members: { some: { userId: me.userId } } }, include: { members: true } });
  const ids = projects.map((p) => p.id);
  const [people, sprints, epics] = await Promise.all([
    db.user.findMany({ where: { id: { in: [...new Set(projects.flatMap((p) => p.members.map((m) => m.userId)))] } }, select: { id: true, name: true, email: true } }),
    db.sprint.findMany({ where: { projectId: { in: ids } }, select: { id: true, name: true, state: true } }),
    db.task.findMany({ where: { projectId: { in: ids }, type: "epic" }, select: { id: true, title: true, number: true, projectId: true } }),
  ]);
  const [versions, components] = await Promise.all([
    db.version.findMany({ where: { projectId: { in: ids } }, select: { id: true, name: true, status: true } }),
    db.component.findMany({ where: { projectId: { in: ids } }, select: { id: true, name: true } }),
  ]);
  const low = (x: string) => x.trim().toLowerCase();
  let parsed;
  try {
    parsed = parseQuery(text, {
      me: me.userId,
      resolveUser: (x) => (["empty", "none", "unassigned"].includes(low(x)) ? null : people.find((u) => low(u.email) === low(x) || low(u.name ?? "") === low(x) || low(u.name ?? "").split(" ")[0] === low(x))?.id),
      statusIds: (x) => [...new Set(projects.flatMap((p) => workflow(p).filter((st) => low(st.name) === low(x) || st.id === low(x)).map((st) => st.id)))],
      categoryIds: (cat) => [...new Set(projects.flatMap((p) => workflow(p).filter((st) => st.category === (cat === "to do" ? "todo" : cat)).map((st) => st.id)))],
      projectIds: (x) => projects.filter((p) => low(p.key ?? "") === low(x) || low(p.name) === low(x) || p.id === x).map((p) => p.id),
      sprintIds: (x) => (["open", "opensprints()"].includes(low(x)) ? sprints.filter((sp) => sp.state !== "closed") : ["active", "activesprints()"].includes(low(x)) ? sprints.filter((sp) => sp.state === "active") : sprints.filter((sp) => low(sp.name) === low(x) || sp.id === x)).map((sp) => sp.id),
      versionIds: (x) => (["unreleased", "unreleasedversions()"].includes(low(x)) ? versions.filter((v) => v.status === "unreleased") : ["released", "releasedversions()"].includes(low(x)) ? versions.filter((v) => v.status === "released") : versions.filter((v) => low(v.name) === low(x) || v.id === x)).map((v) => v.id),
      componentIds: (x) => components.filter((c) => low(c.name) === low(x) || c.id === x).map((c) => c.id),
      epicIds: (x) => epics.filter((e) => low(e.title) === low(x) || e.id === x || `${low(projects.find((p) => p.id === e.projectId)?.key ?? "")}-${e.number}` === low(x)).map((e) => e.id),
    });
  } catch (e) {
    if (e instanceof QueryError) throw new HttpError(400, e.message);
    throw e;
  }
  const rows = await db.task.findMany({ where: { AND: [parsed.where, { ws: me.ws, projectId: { in: ids }, project: { archived: false } }] }, orderBy: parsed.orderBy, include: COUNT, take: 1000 });
  return decorate(rows);
}

export async function listTasks(me: Me, q: TaskQuery) {
  if (q.q?.trim()) return searchQuery(me, q.q);
  let doneIds: string[] = ["done"];
  const and: Prisma.TaskWhereInput[] = [];
  if (q.projectId) {
    const p = await loadProject(me, q.projectId);
    doneIds = workflow(p).filter((s) => s.category === "done").map((s) => s.id);
    if (q.status?.startsWith("category:")) and.push({ status: { in: workflow(p).filter((s) => s.category === q.status!.slice(9)).map((s) => s.id) } });
    if (q.sprint === "active") {
      const active = await db.sprint.findFirst({ where: { projectId: p.id, state: "active" }, select: { id: true } });
      and.push({ sprintId: active?.id ?? "__none__" });
    }
  }
  if (q.text) {
    const m = /^([A-Za-z][A-Za-z0-9]{1,7})-(\d+)$/.exec(q.text.trim());
    and.push({ OR: [{ title: { contains: q.text, mode: "insensitive" } }, { description: { contains: q.text, mode: "insensitive" } }, ...(m ? [{ number: Number(m[2]), project: { key: m[1].toUpperCase() } }] : [])] });
  }
  const sprint = q.sprint === "backlog" ? { sprintId: null } : q.sprint && q.sprint !== "active" ? { sprintId: q.sprint } : {};
  const where: Prisma.TaskWhereInput = {
    ws: me.ws,
    ...(q.parentId ? { parentId: q.parentId } : q.subtasks ? {} : { parentId: null }),
    ...(q.projectId ? { projectId: q.projectId } : {}),
    ...(q.mine ? { assigneeId: me.userId } : {}),
    ...(q.assignee ? { assigneeId: q.assignee === "none" ? null : q.assignee === "me" ? me.userId : q.assignee } : {}),
    ...(q.reporter ? { createdBy: q.reporter === "me" ? me.userId : q.reporter } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.status && !q.status.startsWith("category:") ? { status: q.status } : {}),
    ...(q.priority !== undefined && Number.isFinite(q.priority) ? { priority: q.priority } : {}),
    ...(q.label ? { labels: { has: q.label } } : {}),
    ...sprint,
    ...(q.epic ? { epicId: q.epic === "none" ? null : q.epic } : {}),
    ...(q.watching ? { watchers: { has: me.userId } } : {}),
    ...(q.open ? { completedAt: null } : {}),
    ...(q.updatedSince ? { updatedAt: { gt: new Date(q.updatedSince) } } : {}),
    ...(q.due === "overdue" ? { due: { lt: today() }, completedAt: null } : {}),
    ...(q.due === "today" ? { due: today() } : {}),
    ...(q.due === "week" ? { due: { gte: today(), lte: new Date(today().getTime() + 7 * 86_400_000) } } : {}),
    ...(q.due === "none" ? { due: null } : {}),
    project: { archived: false, members: { some: { userId: me.userId } } },
    ...(and.length ? { AND: and } : {}),
  };
  const dir = q.dir === "desc" ? "desc" : "asc";
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    q.sort === "key" ? [{ number: dir }]
    : q.sort === "updated" ? [{ updatedAt: q.dir ?? "desc" }]
    : q.sort === "created" ? [{ createdAt: q.dir ?? "desc" }]
    : q.sort === "due" ? [{ due: { sort: dir, nulls: "last" } }]
    : q.sort === "priority" ? [{ priority: q.dir ?? "desc" }, { position: "asc" }]
    : q.sort === "title" ? [{ title: dir }]
    : q.sort === "status" ? [{ status: dir }, { position: "asc" }]
    : [{ position: "asc" }, { createdAt: "asc" }];
  void doneIds;
  const rows = await db.task.findMany({ where, orderBy, include: COUNT, take: 3000 });
  return decorate(rows);
}

// ── Create and change ──────────────────────────────────────────────────────

export type TaskInput = {
  projectId?: string;
  parentId?: string | null;
  epicId?: string | null;
  sprintId?: string | null;
  type?: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  assigneeId?: string | null;
  start?: string | null;
  due?: string | null;
  points?: number | null;
  estimateMin?: number | null;
  labels?: string[];
  custom?: Record<string, unknown>;
  flagged?: boolean;
  flagNote?: string | null;
  versionId?: string | null;
  componentIds?: string[];
  checklist?: { text: string; done: boolean }[];
  links?: { url: string; title?: string }[];
  position?: number;
  messageId?: string;
};

const defsOf = (p: Pick<Project, "fieldDefs">) => (Array.isArray(p.fieldDefs) ? (p.fieldDefs as unknown as FieldDef[]) : []);

const date = (v: string | null | undefined, what: string) => {
  if (v === null || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
  bad(`${what} must be YYYY-MM-DD.`);
};

function clean(input: TaskInput, p: Pick<Project, "statuses">) {
  const d: Record<string, unknown> = {};
  if (input.title !== undefined) {
    d.title = String(input.title).trim().slice(0, 300);
    if (!d.title) bad("A task needs a title.");
  }
  if (input.description !== undefined) d.description = String(input.description).slice(0, 50000);
  if (input.type !== undefined) {
    if (!(TYPES as readonly string[]).includes(input.type)) bad("Unknown issue type.");
    d.type = input.type;
  }
  if (input.status !== undefined) {
    if (!workflow(p).some((s) => s.id === input.status)) bad("That status isn't in this project's workflow.");
    d.status = input.status;
    d.statusAt = new Date();
    d.completedAt = isDone(p, input.status) ? new Date() : null;
  }
  if (input.priority !== undefined) d.priority = Math.max(0, Math.min(3, Math.round(Number(input.priority) || 0)));
  if (input.start !== undefined) d.start = date(input.start, "Start date");
  if (input.due !== undefined) d.due = date(input.due, "Due date");
  if (d.start && d.due && (d.start as Date) > (d.due as Date)) bad("The start date is after the due date.");
  if (input.points !== undefined) d.points = input.points === null || input.points === ("" as unknown) ? null : Math.max(0, Math.min(1000, Number(input.points) || 0));
  if (input.estimateMin !== undefined) d.estimateMin = input.estimateMin === null ? null : Math.max(0, Math.min(100_000, Math.round(Number(input.estimateMin) || 0)));
  if (input.labels !== undefined) d.labels = [...new Set((input.labels ?? []).map((l) => String(l).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (input.checklist !== undefined) d.checklist = (input.checklist ?? []).slice(0, 100).map((c) => ({ text: String(c.text ?? "").slice(0, 300), done: !!c.done }));
  if (input.links !== undefined)
    d.links = (input.links ?? [])
      .filter((l) => /^https?:\/\//i.test(String(l.url ?? "")))
      .slice(0, 50)
      .map((l) => ({ url: String(l.url).slice(0, 2000), title: String(l.title ?? "").slice(0, 200) }));
  if (input.position !== undefined && Number.isFinite(Number(input.position))) d.position = Number(input.position);
  if (input.flagged !== undefined) {
    d.flagged = !!input.flagged;
    if (!input.flagged) d.flagNote = null;
  }
  if (input.flagNote !== undefined && input.flagged !== false) d.flagNote = input.flagNote ? String(input.flagNote).slice(0, 500) : null;
  return d;
}

async function checkAssignee(me: Me, projectMembers: { userId: string }[], assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  if (!projectMembers.some((m) => m.userId === assigneeId)) bad("The assignee must be a member of the project.");
  if (assigneeId !== me.userId && !can(me, "tasks.assign")) throw new HttpError(403, "Your role can't assign tasks to others.", { key: "tasks.assign" });
}

async function checkRefs(p: { id: string }, input: TaskInput, selfId?: string) {
  if (input.versionId) {
    const v = await db.version.findUnique({ where: { id: input.versionId }, select: { projectId: true, status: true } });
    if (!v || v.projectId !== p.id) bad("Pick a release from this project.");
  }
  if (input.componentIds?.length) {
    const n = await db.component.count({ where: { projectId: p.id, id: { in: input.componentIds } } });
    if (n !== new Set(input.componentIds).size) bad("Pick components from this project.");
  }
  if (input.epicId) {
    const e = await db.task.findUnique({ where: { id: input.epicId }, select: { projectId: true, type: true } });
    if (!e || e.projectId !== p.id || e.type !== "epic") bad("Pick an epic from this project.");
    if (input.epicId === selfId) bad("An epic can't belong to itself.");
  }
  if (input.sprintId) {
    const s = await db.sprint.findUnique({ where: { id: input.sprintId }, select: { projectId: true, state: true } });
    if (!s || s.projectId !== p.id) bad("Pick a sprint from this project.");
    if (s.state === "closed") bad("That sprint is closed.");
  }
}

const link = (t: { projectId: string; id: string }) => `/tasks?project=${t.projectId}&task=${t.id}`;
const keyOf = (p: { key: string | null }, t: { number: number }) => `${p.key ?? "TASK"}-${t.number}`;

/** Tell the people watching an issue, except whoever made the change. */
async function tellWatchers(me: Me, t: { id: string; projectId: string; title: string; watchers: string[]; assigneeId: string | null; createdBy: string; number: number }, p: { key: string | null }, title: string, body = "", extra: string[] = [], kind = "task.update") {
  const who = new Set([...t.watchers, ...extra].filter((u) => u && u !== me.userId));
  for (const uid of who) await notify({ ws: me.ws, userId: uid, kind, title: `${keyOf(p, t)} ${title}`.slice(0, 200), body, link: link(t) });
}

export function changed(me: Me, projectId: string, taskIds: string[]) {
  publish(`ws:${me.ws}`, { type: "task", projectId, ids: taskIds.slice(0, 200), by: me.userId });
}

export async function createTask(me: Me, input: TaskInput) {
  if (!input.projectId) bad("projectId is required");
  const p = await loadProject(me, input.projectId, { write: true });
  let parentId: string | null = null;
  if (input.parentId) {
    const parent = await loadTask(me, input.parentId);
    if (parent.projectId !== p.id) bad("A subtask must be in its parent's project.");
    if (parent.parentId) bad("Subtasks can't have their own subtasks.");
    parentId = parent.id;
  }
  await checkRefs(p, input);
  // A component's lead is the default assignee.
  if (!input.assigneeId && input.componentIds?.length) {
    const lead = (await db.component.findMany({ where: { id: { in: input.componentIds } }, select: { leadId: true } })).find((c) => c.leadId && p.members.some((m) => m.userId === c.leadId));
    if (lead) input = { ...input, assigneeId: lead.leadId };
  }
  await checkAssignee(me, p.members, input.assigneeId);
  const first = workflow(p).find((s) => s.category === "todo")!.id;
  const data = clean({ status: first, ...input, ...(parentId ? { type: "subtask" } : {}) }, p);
  if (input.custom !== undefined) data.custom = cleanCustom(input.custom, defsOf(p), {}, p.members.map((m) => m.userId));
  if (!parentId && data.type === "subtask") data.type = "task";
  const last = await db.task.findFirst({ where: { projectId: p.id, parentId, status: data.status as string }, orderBy: { position: "desc" } });
  const number = await nextNumber(p.id);
  const t = await db.task.create({
    data: {
      ws: me.ws, projectId: p.id, parentId, number, createdBy: me.userId, title: "", ...data,
      position: (data.position as number | undefined) ?? (last?.position ?? 0) + 1000,
      assigneeId: input.assigneeId || null,
      epicId: parentId ? null : input.epicId || null,
      sprintId: parentId ? null : input.sprintId || null,
      versionId: input.versionId || null,
      componentIds: [...new Set(input.componentIds ?? [])],
      watchers: [...new Set([me.userId, ...(input.assigneeId ? [input.assigneeId] : [])])],
      messageId: input.messageId ?? null,
    } as never,
    include: COUNT,
  });
  await db.taskActivity.create({ data: { taskId: t.id, userId: me.userId, kind: "created" } });
  if (t.assigneeId && t.assigneeId !== me.userId)
    await notify({ ws: me.ws, userId: t.assigneeId, kind: "task.assigned", title: `${me.name} assigned you ${keyOf(p, t)}: ${t.title}`, link: link(t) });
  changed(me, p.id, [t.id]);
  void runRules(me, p.id, "created", t.id);
  return (await decorate([t]))[0];
}

const FIELD_NAME: Record<string, string> = {
  flagged: "Flag",
  versionId: "Fix version",
  componentIds: "Components",
  title: "Title", description: "Description", type: "Type", status: "Status", priority: "Priority", assigneeId: "Assignee", start: "Start date", due: "Due date",
  points: "Story points", estimateMin: "Estimate", labels: "Labels", epicId: "Epic", sprintId: "Sprint", projectId: "Project", parentId: "Parent",
};
const show = (v: unknown) => (v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : Array.isArray(v) ? v.join(", ") : String(v)).slice(0, 300);

export async function updateTask(me: Me, id: string, input: TaskInput & { projectId?: string }) {
  const t = await loadTask(me, id, { write: true });
  let p = t.project;
  // Moving to another project: a new key there; status, sprint and epic reset to that project's.
  if (input.projectId && input.projectId !== t.projectId) {
    if (t.parentId) bad("Move the parent issue; its subtasks go with it.");
    const to = await loadProject(me, input.projectId, { write: true });
    if (t.assigneeId && !to.members.some((m) => m.userId === t.assigneeId)) input.assigneeId = null;
    const number = await nextNumber(to.id);
    const status = workflow(to).some((s) => s.id === t.status) ? t.status : workflow(to)[0].id;
    await db.task.update({ where: { id: t.id }, data: { projectId: to.id, number, status, sprintId: null, epicId: null } });
    const subs = await db.task.findMany({ where: { parentId: t.id }, select: { id: true } });
    for (const s of subs) await db.task.update({ where: { id: s.id }, data: { projectId: to.id, number: await nextNumber(to.id), status: workflow(to).some((x) => x.id === status) ? status : workflow(to)[0].id } });
    await db.taskActivity.create({ data: { taskId: t.id, userId: me.userId, kind: "field", field: "projectId", from: `${keyOf(p, t)} ${p.name}`, to: `${to.key}-${number} ${to.name}` } });
    changed(me, t.projectId, [t.id]);
    p = { ...to, members: to.members };
    Object.assign(t, { projectId: to.id, number, status, sprintId: null, epicId: null });
  }
  const data = clean(input, p);
  const customChanges: { name: string; from: string; to: string }[] = [];
  if (input.custom !== undefined) {
    const prev = (t.custom ?? {}) as Record<string, unknown>;
    const nextC = cleanCustom(input.custom, defsOf(p), prev, p.members.map((m) => m.userId));
    for (const f of defsOf(p)) if (show(prev[f.id]) !== show(nextC[f.id])) customChanges.push({ name: f.name, from: show(prev[f.id]), to: show(nextC[f.id]) });
    data.custom = nextC;
  }
  if (input.assigneeId !== undefined) {
    await checkAssignee(me, p.members, input.assigneeId);
    data.assigneeId = input.assigneeId || null;
  }
  if (input.epicId !== undefined || input.sprintId !== undefined || input.versionId !== undefined || input.componentIds !== undefined) await checkRefs(p, input, t.id);
  if (input.versionId !== undefined) data.versionId = input.versionId || null;
  if (input.componentIds !== undefined) data.componentIds = [...new Set(input.componentIds)];
  if (input.epicId !== undefined) data.epicId = input.epicId || null;
  if (input.sprintId !== undefined) data.sprintId = input.sprintId || null;
  if (input.type === "epic" && t.parentId) bad("A subtask can't be an epic.");
  if (input.type === "subtask" && !t.parentId) bad("Only issues under a parent are subtasks.");
  if (input.status === t.status) delete data.completedAt;
  // WIP limit: refuse to go over it (the board shows the limit).
  if (input.status && input.status !== t.status) {
    const st = workflow(p).find((s) => s.id === input.status);
    if (st?.wip) {
      const n = await db.task.count({ where: { projectId: p.id, status: st.id, parentId: null } });
      if (n >= st.wip && !t.parentId) throw new HttpError(409, `${st.name} is at its limit of ${st.wip}. Finish something there first, or raise the limit.`, { wip: true });
    }
  }
  if (input.assigneeId && input.assigneeId !== t.assigneeId) data.watchers = [...new Set([...t.watchers, input.assigneeId])];
  const u = await db.task.update({ where: { id: t.id }, data: data as never, include: COUNT });

  // History, notifications and rules for what really changed.
  const before = t as unknown as Record<string, unknown>;
  const after = u as unknown as Record<string, unknown>;
  const fields = Object.keys(data).filter((k) => FIELD_NAME[k] && k !== "position" && show(before[k]) !== show(after[k]));
  if (fields.length) {
    const name = async (k: string, v: unknown) => {
      if (v == null) return "";
      if (k === "status") return statusName(p, String(v));
      if (k === "assigneeId") return (await db.user.findUnique({ where: { id: String(v) }, select: { name: true } }))?.name ?? "someone";
      if (k === "epicId") return (await db.task.findUnique({ where: { id: String(v) }, select: { title: true } }))?.title ?? "";
      if (k === "sprintId") return (await db.sprint.findUnique({ where: { id: String(v) }, select: { name: true } }))?.name ?? "";
      if (k === "versionId") return (await db.version.findUnique({ where: { id: String(v) }, select: { name: true } }))?.name ?? "";
      if (k === "componentIds") return (await db.component.findMany({ where: { id: { in: v as string[] } }, select: { name: true } })).map((c) => c.name).join(", ");
      if (k === "flagged") return v ? `Flagged${after.flagNote ? `: ${after.flagNote}` : ""}` : "";
      if (k === "priority") return ["Low", "Normal", "High", "Urgent"][Number(v)] ?? String(v);
      if (k === "description") return show(v).slice(0, 120);
      return show(v);
    };
    await db.taskActivity.createMany({ data: await Promise.all(fields.map(async (k) => ({ taskId: t.id, userId: me.userId, kind: "field", field: k, from: await name(k, before[k]), to: await name(k, after[k]) }))) });
  }
  if (customChanges.length) await db.taskActivity.createMany({ data: customChanges.map((c) => ({ taskId: t.id, userId: me.userId, kind: "field", field: `custom:${c.name}`, from: c.from, to: c.to })) });
  if (fields.includes("assigneeId") && u.assigneeId && u.assigneeId !== me.userId)
    await notify({ ws: me.ws, userId: u.assigneeId, kind: "task.assigned", title: `${me.name} assigned you ${keyOf(p, u)}: ${u.title}`, link: link(u) });
  if (fields.includes("status")) await tellWatchers(me, { ...u, watchers: u.watchers.filter((w) => w !== u.assigneeId || !fields.includes("assigneeId")) }, p, `moved to ${statusName(p, u.status)}`, u.title);
  changed(me, u.projectId, [u.id]);
  if (fields.includes("status")) void runRules(me, u.projectId, "status", u.id);
  if (fields.includes("assigneeId")) void runRules(me, u.projectId, "assigned", u.id);
  return (await decorate([u]))[0];
}

/** One change applied to many issues (bulk edit); each is checked like a single edit. */
export async function bulkUpdate(me: Me, ids: string[], input: TaskInput & { delete?: boolean }) {
  const list = [...new Set(ids)].slice(0, 200);
  const out: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of list) {
    try {
      if (input.delete) await deleteTask(me, id);
      else await updateTask(me, id, input);
      out.push({ id, ok: true });
    } catch (e) {
      out.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results: out, updated: out.filter((r) => r.ok).length };
}

export async function deleteTask(me: Me, id: string) {
  const t = await loadTask(me, id, { write: true });
  if (!can(me, "tasks.delete")) throw new HttpError(403, "Your role can't delete tasks.", { key: "tasks.delete" });
  await db.task.updateMany({ where: { epicId: t.id }, data: { epicId: null } });
  await db.task.deleteMany({ where: { OR: [{ id: t.id }, { parentId: t.id }] } });
  changed(me, t.projectId, [t.id]);
  return { ok: true };
}

/** A copy of an issue (and its subtasks), linked as "clones". */
export async function cloneTask(me: Me, id: string) {
  const t = await loadTask(me, id, { write: true });
  const copy = await createTask(me, {
    projectId: t.projectId, parentId: t.parentId, epicId: t.epicId, sprintId: t.sprintId, type: t.type === "subtask" && !t.parentId ? "task" : t.type,
    title: `Copy of ${t.title}`.slice(0, 300), description: t.description, priority: t.priority, assigneeId: t.assigneeId,
    start: t.start?.toISOString().slice(0, 10) ?? null, due: t.due?.toISOString().slice(0, 10) ?? null, points: t.points, estimateMin: t.estimateMin,
    labels: t.labels, checklist: (t.checklist as { text: string; done: boolean }[]).map((c) => ({ ...c, done: false })),
  });
  for (const s of await db.task.findMany({ where: { parentId: t.id }, orderBy: { position: "asc" } })) await createTask(me, { projectId: t.projectId, parentId: copy.id, title: s.title, assigneeId: s.assigneeId, priority: s.priority });
  await db.taskLink.create({ data: { fromId: copy.id, toId: t.id, kind: "clones", createdBy: me.userId } });
  return (await decorate([await db.task.findUniqueOrThrow({ where: { id: copy.id }, include: COUNT })]))[0];
}

// ── Comments and mentions ──────────────────────────────────────────────────

/** @Name or @email of project members in a comment. */
async function mentioned(text: string, memberIds: string[]) {
  if (!text.includes("@")) return [];
  const users = await db.user.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true, email: true } });
  const low = text.toLowerCase();
  return users.filter((u) => (u.name && low.includes(`@${u.name.toLowerCase()}`)) || low.includes(`@${u.email.toLowerCase()}`)).map((u) => u.id);
}

export async function addComment(me: Me, id: string, body: string) {
  const t = await loadTask(me, id);
  const text = String(body ?? "").trim().slice(0, 10000);
  if (!text) bad("Write a comment first.");
  const c = await db.taskComment.create({ data: { taskId: t.id, userId: me.userId, body: text } });
  const tags = await mentioned(text, t.project.members.map((m) => m.userId));
  await db.task.update({ where: { id: t.id }, data: { watchers: [...new Set([...t.watchers, me.userId, ...tags])] } });
  await db.taskActivity.create({ data: { taskId: t.id, userId: me.userId, kind: "comment", to: text.slice(0, 200) } });
  for (const uid of tags.filter((u) => u !== me.userId))
    await notify({ ws: me.ws, userId: uid, kind: "task.mention", title: `${me.name} mentioned you on ${keyOf(t.project, t)}`, body: text.slice(0, 200), link: link(t) });
  await tellWatchers(me, { ...t, watchers: t.watchers.filter((w) => !tags.includes(w)) }, t.project, `${me.name} commented`, text.slice(0, 200), [t.assigneeId ?? "", t.createdBy].filter((x) => !tags.includes(x)), "task.comment");
  changed(me, t.projectId, [t.id]);
  return c;
}

export async function editComment(me: Me, commentId: string, body: string | null) {
  const c = await db.taskComment.findUnique({ where: { id: commentId } });
  if (!c) throw new HttpError(404, "Comment not found");
  const t = await loadTask(me, c.taskId);
  if (c.userId !== me.userId && !me.owner) throw new HttpError(403, "You can only change your own comments.");
  if (body === null) {
    await db.taskComment.delete({ where: { id: c.id } });
    changed(me, t.projectId, [t.id]);
    return { ok: true };
  }
  const text = String(body).trim().slice(0, 10000);
  if (!text) bad("A comment can't be empty.");
  const u = await db.taskComment.update({ where: { id: c.id }, data: { body: text, editedAt: new Date() } });
  changed(me, t.projectId, [t.id]);
  return u;
}

export async function setWatching(me: Me, id: string, on: boolean) {
  const t = await loadTask(me, id);
  const w = on ? [...new Set([...t.watchers, me.userId])] : t.watchers.filter((x) => x !== me.userId);
  await db.task.update({ where: { id: t.id }, data: { watchers: w } });
  return { watching: on, watchers: w };
}

// ── Links between issues ───────────────────────────────────────────────────

export async function addLink(me: Me, id: string, kind: string, other: string) {
  const a = await loadTask(me, id, { write: true });
  const b = await loadTask(me, other);
  if (!LINK_KINDS[kind]) bad("Pick blocks, relates, duplicates or clones.");
  if (a.id === b.id) bad("An issue can't link to itself.");
  const exists = await db.taskLink.findFirst({ where: { OR: [{ fromId: a.id, toId: b.id, kind }, { fromId: b.id, toId: a.id, kind: kind === "relates" ? "relates" : "__" }] } });
  if (exists) bad("Those issues are already linked that way.");
  const l = await db.taskLink.create({ data: { fromId: a.id, toId: b.id, kind, createdBy: me.userId } });
  await db.taskActivity.createMany({
    data: [
      { taskId: a.id, userId: me.userId, kind: "link", to: `${LINK_KINDS[kind][0]} ${keyOf(b.project, b)}` },
      { taskId: b.id, userId: me.userId, kind: "link", to: `${LINK_KINDS[kind][1]} ${keyOf(a.project, a)}` },
    ],
  });
  changed(me, a.projectId, [a.id, b.id]);
  return l;
}

export async function removeLink(me: Me, linkId: string) {
  const l = await db.taskLink.findUnique({ where: { id: linkId } });
  if (!l) throw new HttpError(404, "Link not found");
  const a = await loadTask(me, l.fromId, { write: true });
  await db.taskLink.delete({ where: { id: l.id } });
  changed(me, a.projectId, [l.fromId, l.toId]);
  return { ok: true };
}

// ── Time ───────────────────────────────────────────────────────────────────

/** "2h 30m", "90m", "1.5h", "1d" (8h) -> minutes. */
export function parseDuration(s: string) {
  const str = String(s ?? "").trim().toLowerCase();
  if (/^\d+$/.test(str)) return Number(str);
  let total = 0;
  let matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m)/g)) {
    matched = true;
    total += Number(m[1]) * { w: 2400, d: 480, h: 60, m: 1 }[m[2] as "w" | "d" | "h" | "m"];
  }
  return matched ? Math.round(total) : NaN;
}

export async function logWork(me: Me, id: string, input: { time?: string; minutes?: number; note?: string; day?: string }) {
  const t = await loadTask(me, id, { write: true });
  const minutes = input.minutes ?? parseDuration(input.time ?? "");
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) bad("Log between 1 minute and 24 hours, e.g. 1h 30m.");
  const day = input.day ? date(input.day, "Day")! : today();
  const w = await db.taskWorklog.create({ data: { taskId: t.id, userId: me.userId, minutes, note: String(input.note ?? "").slice(0, 500), day } });
  await db.taskActivity.create({ data: { taskId: t.id, userId: me.userId, kind: "worklog", to: `${minutes} min` } });
  changed(me, t.projectId, [t.id]);
  return w;
}

export async function deleteWorklog(me: Me, worklogId: string) {
  const w = await db.taskWorklog.findUnique({ where: { id: worklogId } });
  if (!w) throw new HttpError(404, "Not found");
  const t = await loadTask(me, w.taskId, { write: true });
  if (w.userId !== me.userId && !me.owner) throw new HttpError(403, "You can only remove your own time.");
  await db.taskWorklog.delete({ where: { id: w.id } });
  changed(me, t.projectId, [t.id]);
  return { ok: true };
}

// ── The full issue ─────────────────────────────────────────────────────────

export async function taskDetail(me: Me, id: string) {
  const t = await loadTask(me, id);
  const p = t.project;
  const [subs, comments, activity, attachments, worklogs, from, to, epic, parent, sprint, children] = await Promise.all([
    db.task.findMany({ where: { parentId: t.id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: COUNT }),
    db.taskComment.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "asc" } }),
    db.taskActivity.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "desc" }, take: 200 }),
    db.taskAttachment.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "asc" } }),
    db.taskWorklog.findMany({ where: { taskId: t.id }, orderBy: { day: "desc" } }),
    db.taskLink.findMany({ where: { fromId: t.id }, include: { to: { include: { project: true } } } }),
    db.taskLink.findMany({ where: { toId: t.id }, include: { from: { include: { project: true } } } }),
    t.epicId ? db.task.findUnique({ where: { id: t.epicId } }) : null,
    t.parentId ? db.task.findUnique({ where: { id: t.parentId } }) : null,
    t.sprintId ? db.sprint.findUnique({ where: { id: t.sprintId } }) : null,
    t.type === "epic" ? db.task.findMany({ where: { epicId: t.id }, select: { id: true, number: true, title: true, status: true, points: true } }) : [],
  ]);
  const { project: _p, ...rest } = t;
  const [dto] = await decorate([{ ...rest, _count: { comments: comments.length, attachments: attachments.length } } as Task & { _count: Counts }]);
  return {
    task: dto,
    project: { id: p.id, key: p.key, name: p.name, color: p.color, statuses: workflow(p) },
    subtasks: await decorate(subs),
    comments,
    activity,
    attachments: attachments.map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size, userId: a.userId, createdAt: a.createdAt })),
    worklogs,
    issueLinks: [
      ...from.map((l) => ({ id: l.id, label: LINK_KINDS[l.kind]?.[0] ?? l.kind, kind: l.kind, task: { id: l.to.id, key: keyOf(l.to.project, l.to), title: l.to.title, status: statusName(l.to.project, l.to.status), done: isDone(l.to.project, l.to.status) } })),
      ...to.map((l) => ({ id: l.id, label: LINK_KINDS[l.kind]?.[1] ?? l.kind, kind: l.kind, task: { id: l.from.id, key: keyOf(l.from.project, l.from), title: l.from.title, status: statusName(l.from.project, l.from.status), done: isDone(l.from.project, l.from.status) } })),
    ],
    epic: epic ? { id: epic.id, key: keyOf(p, epic), title: epic.title } : null,
    parent: parent ? { id: parent.id, key: keyOf(p, parent), title: parent.title } : null,
    sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : null,
    epicIssues: children.map((c) => ({ id: c.id, key: keyOf(p, c), title: c.title, done: isDone(p, c.status), points: c.points })),
  };
}

// ── Automation rules (run after changes; kept small and safe) ──────────────

type Rule = { trigger: { on: string; status?: string }; actions: { do: string; value?: string }[] };

export async function runRules(me: Me, projectId: string, on: "created" | "status" | "assigned", taskId: string) {
  try {
    const rules = await db.taskRule.findMany({ where: { projectId, enabled: true } });
    if (!rules.length) return;
    const t = await db.task.findUnique({ where: { id: taskId }, include: { project: { include: { members: true } } } });
    if (!t) return;
    for (const r of rules) {
      const rule = { trigger: r.trigger, actions: r.actions } as unknown as Rule;
      if (rule.trigger.on !== on) continue;
      if (on === "status" && rule.trigger.status && rule.trigger.status !== t.status) continue;
      const data: Record<string, unknown> = {};
      for (const a of rule.actions) {
        if (a.do === "assign") {
          const to = a.value === "reporter" ? t.createdBy : a.value === "unassigned" ? null : a.value;
          if (to === null || t.project.members.some((m) => m.userId === to)) data.assigneeId = to;
        } else if (a.do === "status" && a.value && workflow(t.project).some((s) => s.id === a.value)) {
          data.status = a.value;
          data.completedAt = isDone(t.project, a.value) ? new Date() : null;
        } else if (a.do === "label" && a.value) data.labels = [...new Set([...t.labels, a.value.slice(0, 40)])];
        else if (a.do === "comment" && a.value) await db.taskComment.create({ data: { taskId: t.id, userId: r.createdBy, body: `🤖 ${a.value.slice(0, 2000)}` } });
        else if (a.do === "notify") {
          const uid = a.value === "assignee" ? t.assigneeId : a.value === "reporter" ? t.createdBy : a.value;
          if (uid) await notify({ ws: t.ws, userId: uid, kind: "task.rule", title: `${r.name}: ${keyOf(t.project, t)} ${t.title}`.slice(0, 200), link: link(t) });
        }
      }
      if (Object.keys(data).length) {
        await db.task.update({ where: { id: t.id }, data: data as never });
        await db.taskActivity.create({ data: { taskId: t.id, userId: r.createdBy, kind: "field", field: "rule", to: r.name } });
      }
      await db.taskRule.update({ where: { id: r.id }, data: { runs: { increment: 1 } } });
    }
    changed(me, projectId, [taskId]);
  } catch (e) {
    console.error("task rule", e);
  }
}
