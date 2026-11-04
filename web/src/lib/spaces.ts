import { db } from "./db";
import { effectiveForRequest, PermissionError } from "./iotx/permissions";
import { visibleTo } from "./projects";
import { siteOrigin } from "./site-host";

/**
 * Dashboards and folders in the suite's sidebar.
 *
 * Who sees one: workspace owners and people with "spaces.manage" see all; the
 * creator sees theirs; everyone else sees it when one of their roles, or they
 * themselves, is on its access list. Roles are ticked in Admin → Roles, people
 * through Share. The apps inside a dashboard keep their own access rules.
 */

export type SpaceKind = "dashboard" | "folder";

type Viewer = { userId: string; workspaceId: string; roleIds: string[]; manage: boolean; keys: Set<string> };

export async function viewer(userId: string, workspaceId: string): Promise<Viewer> {
  const e = await effectiveForRequest(userId, workspaceId);
  if (!e) throw new PermissionError("You're not in this workspace.", 403);
  const keys = new Set(e.keys);
  return { userId, workspaceId, roleIds: e.roles.map((r) => r.id), manage: e.isOwner || keys.has("spaces.manage"), keys };
}

const can = (v: Viewer, key: string) => v.manage || v.keys.has(key);

type Row = { id: string; createdById: string | null; access: { subjectType: string; subjectId: string }[] };

export function sees(v: Viewer, s: Row) {
  if (v.manage || s.createdById === v.userId) return true;
  return s.access.some((a) => (a.subjectType === "role" && v.roleIds.includes(a.subjectId)) || (a.subjectType === "user" && a.subjectId === v.userId));
}

/** Rename, delete, reorder and share: managers and the creator (sharing also needs "spaces.share"). */
const owns = (v: Viewer, s: { createdById: string | null }) => v.manage || s.createdById === v.userId;

async function load(v: Viewer, id: string) {
  const s = await db.suiteSpace.findFirst({ where: { id, workspaceId: v.workspaceId }, include: { access: true } });
  if (!s || !sees(v, s)) throw new PermissionError("That dashboard or folder doesn't exist, or you don't have access to it.", 404);
  return s;
}

/** The sidebar: every dashboard and folder the person sees, with folder contents. */
export async function sidebar(v: Viewer) {
  const all = await db.suiteSpace.findMany({
    where: { workspaceId: v.workspaceId },
    include: { access: true, items: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  const shown = all.filter((s) => sees(v, s));
  const ids = new Set(shown.map((s) => s.id));
  const out = shown.map((s) => ({
    id: s.id,
    kind: s.kind as SpaceKind,
    name: s.name,
    // A space whose folder the person can't see moves to the top level for them.
    parentId: s.parentId && ids.has(s.parentId) ? s.parentId : null,
    items: s.kind === "folder" ? s.items.map((i) => ({ id: i.id, kind: i.kind, ref: i.ref, title: i.title })) : [],
    modules: s.kind === "dashboard" ? s.items.length : 0,
    mine: owns(v, s),
  }));
  return {
    spaces: out,
    can: {
      dashboard: can(v, "spaces.dashboards.create"),
      folder: can(v, "spaces.folders.create"),
      add: can(v, "spaces.add"),
      share: can(v, "spaces.share"),
      manage: v.manage,
    },
  };
}

/** One dashboard or folder, opened: its items with each app's address. */
export async function open(v: Viewer, id: string) {
  const s = await load(v, id);
  const items = await db.suiteSpaceItem.findMany({ where: { spaceId: id }, orderBy: [{ order: "asc" }, { createdAt: "asc" }] });
  const projectIds = items.filter((i) => i.kind === "project").map((i) => i.ref);
  const where = await visibleTo(v.userId, v.workspaceId);
  const projects = projectIds.length
    ? await db.project.findMany({
        where: { AND: [where, { id: { in: projectIds }, workspaceId: v.workspaceId, deletedAt: null }] },
        select: { id: true, name: true, emoji: true, subdomain: true, publishedSha: true, description: true },
      })
    : [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const children = await db.suiteSpace.findMany({ where: { workspaceId: v.workspaceId, parentId: id }, include: { access: true }, orderBy: [{ order: "asc" }, { createdAt: "asc" }] });
  return {
    id: s.id,
    kind: s.kind as SpaceKind,
    name: s.name,
    mine: owns(v, s),
    canAdd: can(v, "spaces.add") || owns(v, s),
    canShare: v.manage || (owns(v, s) && v.keys.has("spaces.share")),
    children: children.filter((c) => sees(v, c)).map((c) => ({ id: c.id, kind: c.kind as SpaceKind, name: c.name })),
    items: items.map((i) => {
      if (i.kind !== "project") return { id: i.id, kind: i.kind, title: i.title, url: i.ref, status: "ok" as const };
      const p = byId.get(i.ref);
      if (!p) return { id: i.id, kind: i.kind, title: i.title, url: null, status: "no_access" as const };
      return {
        id: i.id,
        kind: i.kind,
        title: p.name,
        emoji: p.emoji,
        description: p.description,
        projectId: p.id,
        // A published app runs on its own subdomain; an unpublished one opens in the Builder.
        url: p.publishedSha ? siteOrigin(p.subdomain) : null,
        editor: `/projects/${p.id}`,
        status: p.publishedSha ? ("ok" as const) : ("unpublished" as const),
      };
    }),
  };
}

export async function create(v: Viewer, kind: SpaceKind, name: string, parentId?: string | null) {
  if (!can(v, kind === "dashboard" ? "spaces.dashboards.create" : "spaces.folders.create"))
    throw new PermissionError(`Your role doesn't include creating ${kind === "dashboard" ? "dashboards" : "folders"}.`, 403);
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new PermissionError("Give it a name.");
  if (parentId) {
    const p = await load(v, parentId);
    if (p.kind !== "folder") throw new PermissionError("Only folders can hold other dashboards and folders.");
  }
  return db.suiteSpace.create({ data: { workspaceId: v.workspaceId, kind, name: clean, parentId: parentId ?? null, createdById: v.userId } });
}

export async function rename(v: Viewer, id: string, name: string) {
  const s = await load(v, id);
  if (!owns(v, s)) throw new PermissionError("Only its creator or a manager can rename it.", 403);
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new PermissionError("Give it a name.");
  await db.suiteSpace.update({ where: { id }, data: { name: clean } });
}

export async function remove(v: Viewer, id: string) {
  const s = await load(v, id);
  if (!owns(v, s)) throw new PermissionError("Only its creator or a manager can delete it.", 403);
  // What was inside a deleted folder moves up a level rather than disappearing.
  await db.$transaction([
    db.suiteSpace.updateMany({ where: { workspaceId: v.workspaceId, parentId: id }, data: { parentId: s.parentId } }),
    db.suiteSpace.delete({ where: { id } }),
  ]);
}

export async function move(v: Viewer, id: string, parentId: string | null) {
  const s = await load(v, id);
  if (!owns(v, s)) throw new PermissionError("Only its creator or a manager can move it.", 403);
  if (parentId) {
    const p = await load(v, parentId);
    if (p.kind !== "folder") throw new PermissionError("Only folders can hold other dashboards and folders.");
    // No folder inside itself or its own subfolders.
    for (let at: string | null = parentId; at; ) {
      if (at === id) throw new PermissionError("A folder can't go inside itself.");
      at = (await db.suiteSpace.findUnique({ where: { id: at }, select: { parentId: true } }))?.parentId ?? null;
    }
  }
  await db.suiteSpace.update({ where: { id }, data: { parentId } });
}

export async function addItem(v: Viewer, spaceId: string, item: { kind: "project" | "link"; ref: string; title?: string }) {
  const s = await load(v, spaceId);
  if (!(can(v, "spaces.add") || owns(v, s))) throw new PermissionError("Your role doesn't include adding to dashboards and folders.", 403);
  let title = (item.title ?? "").trim().slice(0, 120);
  if (item.kind === "project") {
    const where = await visibleTo(v.userId, v.workspaceId);
    const p = await db.project.findFirst({ where: { AND: [where, { id: item.ref, workspaceId: v.workspaceId, deletedAt: null }] }, select: { name: true } });
    if (!p) throw new PermissionError("That app doesn't exist, or you can't see it.", 404);
    title ||= p.name;
  } else {
    const ref = item.ref.trim();
    const ok = ref.startsWith("/") ? !ref.startsWith("//") : /^https?:\/\//i.test(ref);
    if (!ok) throw new PermissionError("Links start with / (a page in the suite) or https://.");
    item = { ...item, ref };
    title ||= ref;
  }
  if (s.kind === "dashboard" && item.kind !== "project") throw new PermissionError("Dashboards hold apps built in the Builder.");
  const dup = await db.suiteSpaceItem.findFirst({ where: { spaceId, kind: item.kind, ref: item.ref } });
  if (dup) return dup;
  const last = await db.suiteSpaceItem.aggregate({ where: { spaceId }, _max: { order: true } });
  return db.suiteSpaceItem.create({ data: { spaceId, kind: item.kind, ref: item.ref, title, order: (last._max.order ?? 0) + 1, addedById: v.userId } });
}

export async function removeItem(v: Viewer, itemId: string) {
  const item = await db.suiteSpaceItem.findUnique({ where: { id: itemId } });
  if (!item) return;
  const s = await load(v, item.spaceId);
  if (!(owns(v, s) || (can(v, "spaces.add") && item.addedById === v.userId))) throw new PermissionError("Only its creator or a manager can remove that.", 403);
  await db.suiteSpaceItem.delete({ where: { id: itemId } });
}

/** Who sees it: roles and people. Admins set roles in Admin → Roles; creators share their own. */
export async function access(v: Viewer, id: string) {
  const s = await load(v, id);
  const [roles, members] = await Promise.all([
    db.permRole.findMany({ where: { workspaceId: v.workspaceId }, select: { id: true, name: true, builtin: true }, orderBy: { name: "asc" } }),
    db.membership.findMany({ where: { workspaceId: v.workspaceId }, select: { userId: true, user: { select: { name: true, email: true } } } }),
  ]);
  return {
    roles: roles.map((r) => ({ id: r.id, name: r.name, builtin: r.builtin, on: s.access.some((a) => a.subjectType === "role" && a.subjectId === r.id) })),
    people: members.map((m) => ({ id: m.userId, name: m.user.name, email: m.user.email, on: s.access.some((a) => a.subjectType === "user" && a.subjectId === m.userId) })),
    createdById: s.createdById,
  };
}

export async function setAccess(v: Viewer, id: string, subjectType: "role" | "user", subjectId: string, on: boolean) {
  const s = await load(v, id);
  if (!(v.manage || (owns(v, s) && v.keys.has("spaces.share")))) throw new PermissionError("Your role doesn't include sharing this.", 403);
  const exists =
    subjectType === "role"
      ? await db.permRole.findFirst({ where: { id: subjectId, workspaceId: v.workspaceId }, select: { id: true } })
      : await db.membership.findUnique({ where: { userId_workspaceId: { userId: subjectId, workspaceId: v.workspaceId } }, select: { userId: true } });
  if (!exists) throw new PermissionError(subjectType === "role" ? "No such role." : "That person isn't in this workspace.", 404);
  const key = { spaceId_subjectType_subjectId: { spaceId: id, subjectType, subjectId } };
  if (on) await db.suiteSpaceAccess.upsert({ where: key, create: { spaceId: id, subjectType, subjectId }, update: {} });
  else await db.suiteSpaceAccess.deleteMany({ where: { spaceId: id, subjectType, subjectId } });
}

/** Admin → Roles: every dashboard and folder, and whether this role sees it. Managers only. */
export async function forRole(v: Viewer, roleId: string) {
  if (!v.manage) throw new PermissionError("Your role doesn't include managing dashboards and folders.", 403);
  const all = await db.suiteSpace.findMany({ where: { workspaceId: v.workspaceId }, include: { access: true }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  return all.map((s) => ({
    id: s.id,
    kind: s.kind as SpaceKind,
    name: s.name,
    parentId: s.parentId,
    on: s.access.some((a) => a.subjectType === "role" && a.subjectId === roleId),
    people: s.access.filter((a) => a.subjectType === "user").length,
  }));
}

/** Apps someone can put in a dashboard or folder: the workspace's projects they can see. */
export async function pickableApps(v: Viewer) {
  const where = await visibleTo(v.userId, v.workspaceId);
  const ps = await db.project.findMany({
    where: { AND: [where, { workspaceId: v.workspaceId, deletedAt: null, isTemplate: false }] },
    select: { id: true, name: true, emoji: true, publishedSha: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return ps.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, published: !!p.publishedSha }));
}
