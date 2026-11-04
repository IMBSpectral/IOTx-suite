import { db } from "./db";
import { audit } from "./workspace-security";
import { canManageRoles, invalidatePerms, PermissionError } from "./iotx/permissions";

/**
 * Company structure: a tree of departments (each with a head) and every
 * member's employee profile (department, manager, title, HR details).
 * Everyone in the workspace can see the structure and the directory; HR
 * details (phone, employee code, joining date) are shown to managers of the
 * workspace and to the person's own managers up the chain. Changing the
 * structure needs an owner, an admin, or "Manage roles and permissions".
 * Roles given to a department apply to everyone in it and below it
 * (iotx/permissions rolesFor).
 */

export type Dept = { id: string; name: string; parentId: string | null; headId: string | null; color: string | null; order: number };
export type Person = {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  joinedWorkspace: string;
  mfa: boolean;
  departmentId: string | null;
  managerId: string | null;
  title: string | null;
  location: string | null;
  phone: string | null;
  employeeCode: string | null;
  joinedOn: string | null;
  hr: boolean;
};

export async function canEditStructure(userId: string, workspaceId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } });
  if (m?.role === "OWNER" || m?.role === "ADMIN") return true;
  return canManageRoles(userId, workspaceId);
}

async function requireEditor(userId: string, workspaceId: string) {
  if (!(await canEditStructure(userId, workspaceId))) throw new PermissionError("Changing the company structure needs an owner or admin.", 403);
}

/** A department and every department under it. */
export function subtree(depts: Pick<Dept, "id" | "parentId">[], rootId: string) {
  const out = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of depts) if (d.parentId && out.has(d.parentId) && !out.has(d.id)) out.add(d.id), (grew = true);
  }
  return out;
}

/** A person's department and every department above it (for roles given to a department). */
export async function departmentChain(userId: string, workspaceId: string) {
  const p = await db.employeeProfile.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { departmentId: true } });
  if (!p?.departmentId) return [];
  const depts = await db.department.findMany({ where: { workspaceId }, select: { id: true, parentId: true } });
  const by = new Map(depts.map((d) => [d.id, d]));
  const out: string[] = [];
  for (let at: string | null | undefined = p.departmentId; at && !out.includes(at); at = by.get(at)?.parentId) out.push(at);
  return out;
}

/** Everyone who reports to this person, directly or further down. */
export function reportsOf(people: Pick<Person, "userId" | "managerId">[], userId: string) {
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of people) if (p.managerId && (p.managerId === userId || out.has(p.managerId)) && !out.has(p.userId) && p.userId !== userId) out.add(p.userId), (grew = true);
  }
  return out;
}

/** The whole structure, as the viewer may see it. */
export async function loadStructure(viewerId: string, workspaceId: string) {
  const [depts, members, profiles, editor] = await Promise.all([
    db.department.findMany({ where: { workspaceId }, orderBy: [{ order: "asc" }, { name: "asc" }] }),
    db.membership.findMany({ where: { workspaceId }, include: { user: { select: { id: true, name: true, email: true, image: true, mfaEnabledAt: true } } }, orderBy: { createdAt: "asc" } }),
    db.employeeProfile.findMany({ where: { workspaceId } }),
    canEditStructure(viewerId, workspaceId),
  ]);
  const prof = new Map(profiles.map((p) => [p.userId, p]));
  const base = members.map((m) => ({ userId: m.userId, managerId: prof.get(m.userId)?.managerId ?? null }));
  const mine = reportsOf(base, viewerId);
  const people: Person[] = members.map((m) => {
    const p = prof.get(m.userId);
    const hr = editor || m.userId === viewerId || mine.has(m.userId);
    return {
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
      role: m.role,
      joinedWorkspace: m.createdAt.toISOString(),
      mfa: !!m.user.mfaEnabledAt,
      departmentId: p?.departmentId ?? null,
      managerId: p?.managerId ?? null,
      title: p?.title ?? null,
      location: p?.location ?? null,
      phone: hr ? (p?.phone ?? null) : null,
      employeeCode: hr ? (p?.employeeCode ?? null) : null,
      joinedOn: hr && p?.joinedOn ? p.joinedOn.toISOString().slice(0, 10) : null,
      hr,
    };
  });
  return {
    departments: depts.map((d) => ({ id: d.id, name: d.name, parentId: d.parentId, headId: d.headId, color: d.color, order: d.order })),
    people,
    canEdit: editor,
    me: viewerId,
  };
}

const clean = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) || null : v === null ? null : undefined);

async function deptIn(workspaceId: string, id: string) {
  const d = await db.department.findFirst({ where: { id, workspaceId } });
  if (!d) throw new PermissionError("That department doesn't exist.", 404);
  return d;
}
async function memberIn(workspaceId: string, userId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, include: { user: { select: { name: true, email: true } } } });
  if (!m) throw new PermissionError("That person isn't in this workspace.", 404);
  return m;
}
const done = async (workspaceId: string, actorId: string, detail: string, perms = false) => {
  if (perms) invalidatePerms();
  await audit(workspaceId, actorId, "people.changed", detail);
};

export async function createDepartment(actorId: string, workspaceId: string, b: { name?: unknown; parentId?: unknown; headId?: unknown; color?: unknown }) {
  await requireEditor(actorId, workspaceId);
  const name = clean(b.name, 80);
  if (!name) throw new PermissionError("Give the department a name.");
  const parentId = typeof b.parentId === "string" && b.parentId ? (await deptIn(workspaceId, b.parentId)).id : null;
  const headId = typeof b.headId === "string" && b.headId ? (await memberIn(workspaceId, b.headId)).userId : null;
  const last = await db.department.aggregate({ where: { workspaceId, parentId }, _max: { order: true } });
  const d = await db.department.create({ data: { workspaceId, name, parentId, headId, color: clean(b.color, 20) ?? null, order: (last._max.order ?? 0) + 1 } });
  await done(workspaceId, actorId, `Created the department ${name}`);
  return d;
}

export async function updateDepartment(actorId: string, workspaceId: string, id: string, b: { name?: unknown; parentId?: unknown; headId?: unknown; color?: unknown }) {
  await requireEditor(actorId, workspaceId);
  const d = await deptIn(workspaceId, id);
  const data: { name?: string; parentId?: string | null; headId?: string | null; color?: string | null } = {};
  if (b.name !== undefined) {
    const n = clean(b.name, 80);
    if (!n) throw new PermissionError("Give the department a name.");
    data.name = n;
  }
  if (b.parentId !== undefined) {
    const p = typeof b.parentId === "string" && b.parentId ? await deptIn(workspaceId, b.parentId) : null;
    if (p) {
      const all = await db.department.findMany({ where: { workspaceId }, select: { id: true, parentId: true } });
      if (subtree(all, id).has(p.id)) throw new PermissionError("A department can't go inside itself or one of its own sub-departments.");
    }
    data.parentId = p?.id ?? null;
  }
  if (b.headId !== undefined) data.headId = typeof b.headId === "string" && b.headId ? (await memberIn(workspaceId, b.headId)).userId : null;
  if (b.color !== undefined) data.color = clean(b.color, 20) ?? null;
  const out = await db.department.update({ where: { id }, data });
  await done(workspaceId, actorId, `Changed the department ${d.name}${data.name && data.name !== d.name ? ` (now ${data.name})` : ""}`, data.parentId !== undefined);
  return out;
}

/** Deleting a department moves its people and sub-departments up to its parent. */
export async function deleteDepartment(actorId: string, workspaceId: string, id: string) {
  await requireEditor(actorId, workspaceId);
  const d = await deptIn(workspaceId, id);
  await db.$transaction([
    db.department.updateMany({ where: { workspaceId, parentId: id }, data: { parentId: d.parentId } }),
    db.employeeProfile.updateMany({ where: { workspaceId, departmentId: id }, data: { departmentId: d.parentId } }),
    db.permAssignment.deleteMany({ where: { workspaceId, subjectType: "department", subjectId: id } }),
    db.department.delete({ where: { id } }),
  ]);
  await done(workspaceId, actorId, `Deleted the department ${d.name}`, true);
}

/** Change one person's place and details. Fields left out stay as they are. */
export async function updatePerson(
  actorId: string,
  workspaceId: string,
  userId: string,
  b: { departmentId?: unknown; managerId?: unknown; title?: unknown; phone?: unknown; employeeCode?: unknown; location?: unknown; joinedOn?: unknown },
) {
  await requireEditor(actorId, workspaceId);
  const m = await memberIn(workspaceId, userId);
  const data: Record<string, string | Date | null> = {};
  if (b.departmentId !== undefined) data.departmentId = typeof b.departmentId === "string" && b.departmentId ? (await deptIn(workspaceId, b.departmentId)).id : null;
  if (b.managerId !== undefined) {
    const mgr = typeof b.managerId === "string" && b.managerId ? (await memberIn(workspaceId, b.managerId)).userId : null;
    if (mgr === userId) throw new PermissionError("Someone can't be their own manager.");
    if (mgr) {
      // No loops: the new manager can't report to this person.
      const all = await db.employeeProfile.findMany({ where: { workspaceId }, select: { userId: true, managerId: true } });
      if (reportsOf(all, userId).has(mgr)) throw new PermissionError("That would make a loop: the new manager already reports to this person.");
    }
    data.managerId = mgr;
  }
  for (const k of ["title", "phone", "employeeCode", "location"] as const) if (b[k] !== undefined) data[k] = clean(b[k], 120) ?? null;
  if (b.joinedOn !== undefined) {
    const s = clean(b.joinedOn, 20);
    const dt = s ? new Date(`${s}T00:00:00Z`) : null;
    if (s && Number.isNaN(dt!.getTime())) throw new PermissionError("Joining date must be YYYY-MM-DD.");
    data.joinedOn = dt;
  }
  const out = await db.employeeProfile.upsert({ where: { workspaceId_userId: { workspaceId, userId } }, create: { workspaceId, userId, ...data }, update: data });
  await done(workspaceId, actorId, `Updated ${m.user.name ?? m.user.email} in the company structure`, data.departmentId !== undefined);
  return out;
}

/** Move several people into one department (null: no department). */
export async function movePeople(actorId: string, workspaceId: string, userIds: string[], departmentId: string | null) {
  await requireEditor(actorId, workspaceId);
  const dept = departmentId ? await deptIn(workspaceId, departmentId) : null;
  const ids = [...new Set(userIds)].slice(0, 500);
  const members = await db.membership.findMany({ where: { workspaceId, userId: { in: ids } }, select: { userId: true } });
  for (const m of members) {
    await db.employeeProfile.upsert({
      where: { workspaceId_userId: { workspaceId, userId: m.userId } },
      create: { workspaceId, userId: m.userId, departmentId: dept?.id ?? null },
      update: { departmentId: dept?.id ?? null },
    });
  }
  await done(workspaceId, actorId, `Moved ${members.length} ${members.length === 1 ? "person" : "people"} to ${dept?.name ?? "no department"}`, true);
  return members.length;
}

export type InviteRow = {
  email: string;
  name?: string;
  title?: string;
  /** A department id, a name, or a path like "Plant › Production" (made if it doesn't exist yet). */
  department?: string;
  /** The manager's email (someone already in the workspace or further up this list). */
  manager?: string;
  role?: string;
  phone?: string;
  employeeCode?: string;
  location?: string;
  joinedOn?: string;
};
export type InviteResult = { email: string; ok: boolean; note: string };

/**
 * Add people and place them in one go (the People screen's "Add people", one
 * person or a CSV). New addresses become members who get access when they
 * sign in with that email; nobody is emailed from here. People already in
 * the workspace just get their place and details updated. Owners and admins only.
 */
export async function invitePeople(actorId: string, workspaceId: string, rows: InviteRow[]): Promise<InviteResult[]> {
  const me = await db.membership.findUnique({ where: { userId_workspaceId: { userId: actorId, workspaceId } }, select: { role: true } });
  if (me?.role !== "OWNER" && me?.role !== "ADMIN") throw new PermissionError("Adding people needs an owner or admin.", 403);
  const { inviteAllowed } = await import("./workspace-security");
  const { assertSeat, MembersError } = await import("./members-extra");
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const depts = await db.department.findMany({ where: { workspaceId } });
  const out: InviteResult[] = [];
  const placed: { userId: string; email: string; manager?: string }[] = [];

  // A department by id, name or "A › B" path; missing ones on a path are made.
  const deptFor = async (ref: string) => {
    const byId = depts.find((d) => d.id === ref);
    if (byId) return byId.id;
    const parts = ref.split(/\s*(?:›|>|\/)\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
    if (parts.length === 1) {
      const hit = depts.find((d) => d.name.toLowerCase() === parts[0].toLowerCase());
      if (hit) return hit.id;
    }
    let parent: string | null = null;
    for (const name of parts) {
      let d = depts.find((x) => x.parentId === parent && x.name.toLowerCase() === name.toLowerCase());
      if (!d) {
        d = await db.department.create({ data: { workspaceId, name: name.slice(0, 80), parentId: parent } });
        depts.push(d);
      }
      parent = d.id;
    }
    return parent;
  };

  for (const r of rows.slice(0, 500)) {
    const email = String(r.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      out.push({ email: email || "(blank)", ok: false, note: "Not a valid email." });
      continue;
    }
    try {
      let user = await db.user.findUnique({ where: { email } });
      let member = user ? await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId } } }) : null;
      let note = "Updated.";
      if (!member) {
        if (!inviteAllowed(ws, email)) {
          out.push({ email, ok: false, note: "Only addresses on the workspace's verified domains can be added." });
          continue;
        }
        await assertSeat(workspaceId);
        user ??= await db.user.create({ data: { email, name: r.name?.trim().slice(0, 120) || null } });
        const role = String(r.role ?? "").toUpperCase();
        member = await db.membership.create({ data: { userId: user.id, workspaceId, role: role === "ADMIN" || role === "VIEWER" ? role : "MEMBER" } });
        await audit(workspaceId, actorId, "member.invited", `Added ${email} as ${member.role.toLowerCase()} from People`);
        note = "Added; they get access when they sign in with this email.";
      } else if (!user!.name && r.name) {
        await db.user.update({ where: { id: user!.id }, data: { name: r.name.trim().slice(0, 120) } });
      }
      const data: Record<string, string | Date | null> = {};
      if (r.department?.trim()) data.departmentId = await deptFor(r.department.trim());
      for (const k of ["title", "phone", "employeeCode", "location"] as const) if (r[k]?.trim()) data[k] = r[k]!.trim().slice(0, 120);
      if (r.joinedOn?.trim()) {
        const d = new Date(`${r.joinedOn.trim()}T00:00:00Z`);
        if (!Number.isNaN(d.getTime())) data.joinedOn = d;
      }
      await db.employeeProfile.upsert({ where: { workspaceId_userId: { workspaceId, userId: user!.id } }, create: { workspaceId, userId: user!.id, ...data }, update: data });
      placed.push({ userId: user!.id, email, manager: r.manager?.trim().toLowerCase() || undefined });
      out.push({ email, ok: true, note });
    } catch (e) {
      if (e instanceof MembersError || e instanceof PermissionError) out.push({ email, ok: false, note: e.message });
      else throw e;
    }
  }

  // Managers last, so someone further down the list can manage someone above them.
  for (const p of placed.filter((x) => x.manager)) {
    const mgr = await db.user.findUnique({ where: { email: p.manager! }, select: { id: true } });
    const inWs = mgr && (await db.membership.findUnique({ where: { userId_workspaceId: { userId: mgr.id, workspaceId } } }));
    const row = out.find((o) => o.ok && o.email === p.email);
    if (!inWs || mgr!.id === p.userId) {
      if (row) row.note += ` Manager ${p.manager} isn't in the workspace, so no manager was set.`;
      continue;
    }
    const all = await db.employeeProfile.findMany({ where: { workspaceId }, select: { userId: true, managerId: true } });
    if (reportsOf(all, p.userId).has(mgr!.id)) continue;
    await db.employeeProfile.update({ where: { workspaceId_userId: { workspaceId, userId: p.userId } }, data: { managerId: mgr!.id } });
  }
  invalidatePerms();
  await audit(workspaceId, actorId, "people.changed", `Added or placed ${out.filter((o) => o.ok).length} people from People`);
  return out;
}
