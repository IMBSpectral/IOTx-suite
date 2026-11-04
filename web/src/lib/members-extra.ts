import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Role } from "@prisma/client";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { audit } from "./workspace-security";
import { notify } from "./sharing";

/**
 * More member management for a workspace: member profiles, groups (share a
 * project with everyone in one), invite links by role, a seat cap, and
 * requests to move up a role (approved in the action center).
 */

type Store = {
  seatCap: number | null;
  groups: { id: string; name: string; members: string[] }[];
  links: { token: string; role: Role; expiresAt: string | null; maxUses: number | null; uses: number; createdBy: string; createdAt: string }[];
  roleRequests: { id: string; userId: string; from: Role; to: Role; reason: string; at: string; status: "pending" | "approved" | "declined" }[];
};

export class MembersError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

const file = (ws: string) => path.join(PROJECTS_ROOT, "_forge", "members", `${ws.replace(/[^\w-]/g, "")}.json`);
async function load(ws: string): Promise<Store> {
  const raw = await fs.readFile(file(ws), "utf8").catch(() => null);
  return { seatCap: null, groups: [], links: [], roleRequests: [], ...(raw ? (JSON.parse(raw) as Partial<Store>) : {}) };
}
async function save(ws: string, s: Store) {
  await fs.mkdir(path.dirname(file(ws)), { recursive: true });
  await fs.writeFile(file(ws), JSON.stringify(s, null, 2));
  // Groups feed IOTx Suite role assignments: drop cached permission decisions.
  const g = globalThis as { __iotxPermsVersion?: number };
  g.__iotxPermsVersion = (g.__iotxPermsVersion ?? 0) + 1;
}
const RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
const ASSIGNABLE: Role[] = ["VIEWER", "MEMBER", "ADMIN"];

export async function membersExtra(ws: string) {
  const s = await load(ws);
  const now = Date.now();
  return {
    seatCap: s.seatCap,
    seats: await db.membership.count({ where: { workspaceId: ws } }),
    groups: s.groups,
    links: s.links.filter((l) => !l.expiresAt || Date.parse(l.expiresAt) > now),
    roleRequests: s.roleRequests.filter((r) => r.status === "pending"),
  };
}

/** Refuse a new member when the workspace is at its seat cap. */
export async function assertSeat(ws: string) {
  const s = await load(ws);
  if (s.seatCap !== null && (await db.membership.count({ where: { workspaceId: ws } })) >= s.seatCap) {
    throw new MembersError(`This workspace is at its seat cap (${s.seatCap}). An admin can raise it in Members.`, 403);
  }
}

export async function setSeatCap(ws: string, cap: number | null) {
  if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 100_000)) throw new MembersError("The seat cap is a whole number of people.");
  const s = await load(ws);
  s.seatCap = cap;
  await save(ws, s);
}

// ── Profiles ──────────────────────────────────────────────────────────────

export async function memberProfile(ws: string, userId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: ws } }, include: { user: { select: { email: true, name: true, handle: true } } } });
  if (!m) throw new MembersError("Not a member of this workspace.", 404);
  const [created, collabs, last] = await Promise.all([
    db.project.findMany({ where: { workspaceId: ws, createdById: userId, deletedAt: null }, select: { id: true, name: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 50 }),
    db.collaborator.findMany({ where: { userId, project: { workspaceId: ws, deletedAt: null } }, select: { role: true, project: { select: { id: true, name: true } } }, take: 50 }),
    db.message.findFirst({ where: { userId, project: { workspaceId: ws } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const s = await load(ws);
  return {
    userId,
    email: m.user.email,
    name: m.user.name,
    handle: m.user.handle,
    role: m.role,
    joinedAt: m.createdAt.toISOString(),
    lastActive: last?.createdAt.toISOString() ?? null,
    projectsCreated: created.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt.toISOString() })),
    collaborations: collabs.map((c) => ({ id: c.project.id, name: c.project.name, role: c.role })),
    groups: s.groups.filter((g) => g.members.includes(userId)).map((g) => g.name),
  };
}

// ── Groups ────────────────────────────────────────────────────────────────

export async function saveGroup(ws: string, input: { id?: string; name?: string; members?: string[] }) {
  const s = await load(ws);
  const name = (input.name ?? "").trim().slice(0, 60);
  if (!name) throw new MembersError("Name the group.");
  const memberIds = new Set((await db.membership.findMany({ where: { workspaceId: ws }, select: { userId: true } })).map((m) => m.userId));
  const members = [...new Set(input.members ?? [])].filter((u) => memberIds.has(u));
  const existing = input.id ? s.groups.find((g) => g.id === input.id) : undefined;
  if (s.groups.some((g) => g.name.toLowerCase() === name.toLowerCase() && g.id !== existing?.id)) throw new MembersError("There's already a group with that name.");
  if (existing) Object.assign(existing, { name, members });
  else s.groups.push({ id: crypto.randomUUID(), name, members });
  await save(ws, s);
}

export async function deleteGroup(ws: string, id: string) {
  const s = await load(ws);
  s.groups = s.groups.filter((g) => g.id !== id);
  await save(ws, s);
}

/** Share a project with everyone in a group (as collaborators with that access). */
export async function shareWithGroup(ws: string, groupId: string, projectId: string, access: "view" | "edit") {
  const s = await load(ws);
  const g = s.groups.find((x) => x.id === groupId);
  if (!g) throw new MembersError("Group not found.", 404);
  const p = await db.project.findFirst({ where: { id: projectId, workspaceId: ws } });
  if (!p) throw new MembersError("Project not found.", 404);
  const role = access === "edit" ? "MEMBER" : "VIEWER";
  for (const userId of g.members) {
    const c = await db.collaborator.findUnique({ where: { projectId_userId: { projectId, userId } } });
    // Never lower someone's existing access.
    if (c && (c.role === "OWNER" || c.role === "ADMIN" || (c.role === "MEMBER" && role === "VIEWER"))) continue;
    await db.collaborator.upsert({ where: { projectId_userId: { projectId, userId } }, create: { projectId, userId, role }, update: { role } });
  }
  await notify(g.members, { projectId, kind: "shared", title: `${p.name} was shared with ${g.name}`, href: `/projects/${projectId}` });
  return { shared: g.members.length };
}

// ── Invite links ──────────────────────────────────────────────────────────

export async function createInviteLink(ws: string, by: string, input: { role?: string; expiresInDays?: number | null; maxUses?: number | null }) {
  const role = (input.role ?? "MEMBER") as Role;
  if (!ASSIGNABLE.includes(role)) throw new MembersError("Links can invite admins, members or viewers.");
  const s = await load(ws);
  const link = {
    token: crypto.randomBytes(18).toString("base64url"),
    role,
    expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null,
    maxUses: input.maxUses && input.maxUses > 0 ? Math.floor(input.maxUses) : null,
    uses: 0,
    createdBy: by,
    createdAt: new Date().toISOString(),
  };
  s.links.push(link);
  await save(ws, s);
  return link;
}

export async function revokeInviteLink(ws: string, token: string) {
  const s = await load(ws);
  s.links = s.links.filter((l) => l.token !== token);
  await save(ws, s);
}

/** Find the workspace and link for a token (any workspace). */
async function findLink(token: string) {
  const dir = path.join(PROJECTS_ROOT, "_forge", "members");
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    const ws = f.replace(/\.json$/, "");
    const s = await load(ws);
    const link = s.links.find((l) => l.token === token);
    if (link) return { ws, s, link };
  }
  return null;
}

export async function inviteLinkInfo(token: string) {
  const found = await findLink(token);
  if (!found) return null;
  const { ws, link } = found;
  const w = await db.workspace.findUnique({ where: { id: ws }, select: { name: true } });
  const expired = (link.expiresAt && Date.parse(link.expiresAt) < Date.now()) || (link.maxUses !== null && link.uses >= link.maxUses);
  return { workspaceId: ws, workspaceName: w?.name ?? "a workspace", role: link.role, expired: !!expired };
}

export async function joinWithLink(token: string, userId: string) {
  const found = await findLink(token);
  if (!found) throw new MembersError("This invite link isn't active.", 404);
  const { ws, s, link } = found;
  if ((link.expiresAt && Date.parse(link.expiresAt) < Date.now()) || (link.maxUses !== null && link.uses >= link.maxUses)) {
    throw new MembersError("This invite link has expired. Ask for a new one.", 410);
  }
  if (await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: ws } } })) return { workspaceId: ws, already: true };
  await assertSeat(ws);
  await db.membership.create({ data: { userId, workspaceId: ws, role: link.role } });
  link.uses++;
  await save(ws, s);
  const u = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  await audit(ws, userId, "member.invited", `${u?.email ?? userId} joined with an invite link as ${link.role.toLowerCase()}`);
  return { workspaceId: ws, already: false };
}

// ── Role-upgrade requests ─────────────────────────────────────────────────

export async function requestRole(ws: string, userId: string, to: string, reason: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: ws } } });
  if (!m) throw new MembersError("Not a member of this workspace.", 403);
  const want = to as Role;
  if (!ASSIGNABLE.includes(want) || RANK[want] <= RANK[m.role]) throw new MembersError("Ask for a role above your current one.");
  const s = await load(ws);
  if (s.roleRequests.some((r) => r.userId === userId && r.status === "pending")) throw new MembersError("You already have a request waiting.", 409);
  const r = { id: crypto.randomUUID(), userId, from: m.role, to: want, reason: reason.trim().slice(0, 300), at: new Date().toISOString(), status: "pending" as const };
  s.roleRequests.push(r);
  await save(ws, s);
  const admins = await db.membership.findMany({ where: { workspaceId: ws, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } });
  const u = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  await notify(admins.map((a) => a.userId), { kind: "role_request", title: `${u?.email} asks to be ${want.toLowerCase()}`, body: r.reason || undefined, href: "/settings/actions" });
  return r;
}

export async function decideRole(ws: string, adminId: string, id: string, approve: boolean) {
  const s = await load(ws);
  const r = s.roleRequests.find((x) => x.id === id && x.status === "pending");
  if (!r) throw new MembersError("Request not found.", 404);
  r.status = approve ? "approved" : "declined";
  await save(ws, s);
  if (approve) {
    await db.membership.update({ where: { userId_workspaceId: { userId: r.userId, workspaceId: ws } }, data: { role: r.to } });
    await audit(ws, adminId, "workspace.settings", `Role changed to ${r.to.toLowerCase()} on request`);
  }
  await notify([r.userId], { kind: "role_request", title: approve ? `You're now ${r.to.toLowerCase()}` : `Your request to be ${r.to.toLowerCase()} was declined` });
}

/** The workspace's groups (for group -> role assignments in lib/iotx/permissions.ts). */
export async function workspaceGroups(ws: string) {
  return (await load(ws)).groups;
}
