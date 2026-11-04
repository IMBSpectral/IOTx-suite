import { db } from "./db";
import { audit, auditLog } from "./workspace-security";

/**
 * Organizations: several workspaces under one set of org admins. Admins name
 * the org, add or remove workspaces, and set "standardized" settings pushed
 * down to every workspace; an enforced key can't be changed in a workspace.
 * The org audit log brings every workspace's events together.
 */

export class OrgError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

/** Settings an org can standardize, with how to check a value. */
export const STANDARD_KEYS = {
  cloudAutoApprove: (v: unknown) => typeof v === "boolean",
  previewSharing: (v: unknown) => v === "anyone" || v === "password" || v === "signin" || v === "off",
  publishRequiresApproval: (v: unknown) => typeof v === "boolean",
} as const;
export type StandardKey = keyof typeof STANDARD_KEYS;

export async function orgOf(workspaceId: string) {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { org: { include: { members: true } } } });
  return ws?.org ?? null;
}

export async function isOrgAdmin(orgId: string, userId: string) {
  return !!(await db.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } } }));
}

async function requireOrgAdmin(orgId: string, userId: string) {
  if (!(await isOrgAdmin(orgId, userId))) throw new OrgError("Only organization admins can do that.", 403);
}

/** A workspace owner starts an org; their workspace is its first, and they its first admin. */
export async function createOrg(workspaceId: string, userId: string, name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new OrgError("Name the organization.");
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true } });
  if (ws.orgId) throw new OrgError("This workspace already belongs to an organization.");
  const org = await db.organization.create({ data: { name: clean, members: { create: { userId, role: "ADMIN" } } } });
  await db.workspace.update({ where: { id: workspaceId }, data: { orgId: org.id } });
  await audit(workspaceId, userId, "workspace.settings", `Created the organization ${clean}`);
  return org;
}

export async function orgOverview(orgId: string, userId: string) {
  await requireOrgAdmin(orgId, userId);
  const org = await db.organization.findUniqueOrThrow({
    where: { id: orgId },
    include: {
      members: true,
      workspaces: { select: { id: true, name: true, plan: true, _count: { select: { memberships: true, projects: true } } } },
    },
  });
  const people = await db.user.findMany({ where: { id: { in: org.members.map((m) => m.userId) } }, select: { id: true, email: true, name: true } });
  return {
    id: org.id,
    name: org.name,
    avatar: org.avatar,
    settings: (org.settings as Record<string, unknown> | null) ?? {},
    enforced: org.enforced,
    admins: people.map((p) => ({ id: p.id, email: p.email, name: p.name })),
    workspaces: org.workspaces.map((w) => ({ id: w.id, name: w.name, plan: w.plan, members: w._count.memberships, projects: w._count.projects })),
  };
}

export async function updateOrg(orgId: string, userId: string, patch: { name?: string; avatar?: string | null }) {
  await requireOrgAdmin(orgId, userId);
  const data: { name?: string; avatar?: string | null } = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new OrgError("Name the organization.");
    data.name = patch.name.trim().slice(0, 80);
  }
  if (patch.avatar !== undefined) data.avatar = patch.avatar ? patch.avatar.trim().slice(0, 8) : null;
  await db.organization.update({ where: { id: orgId }, data });
}

/** Add an org admin: someone who is already in one of the org's workspaces. */
export async function addAdmin(orgId: string, userId: string, email: string) {
  await requireOrgAdmin(orgId, userId);
  const u = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  const inOrg = u ? await db.membership.count({ where: { userId: u.id, workspace: { orgId } } }) : 0;
  if (!u || !inOrg) throw new OrgError("Add people who are in one of the organization's workspaces.");
  await db.orgMember.upsert({ where: { orgId_userId: { orgId, userId: u.id } }, create: { orgId, userId: u.id }, update: {} });
}

export async function removeAdmin(orgId: string, userId: string, targetId: string) {
  await requireOrgAdmin(orgId, userId);
  if ((await db.orgMember.count({ where: { orgId } })) <= 1) throw new OrgError("An organization needs at least one admin.");
  await db.orgMember.deleteMany({ where: { orgId, userId: targetId } });
}

/** A new workspace in the org, owned by the admin who made it. Standard settings apply from the start. */
export async function createOrgWorkspace(orgId: string, userId: string, name: string) {
  await requireOrgAdmin(orgId, userId);
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new OrgError("Name the workspace.");
  const slug = `${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  const ws = await db.workspace.create({
    data: { name: clean, slug, orgId, ...standardData((org.settings as Record<string, unknown> | null) ?? {}), memberships: { create: { userId, role: "OWNER" } } },
  });
  return ws;
}

/** Take a workspace out of the org (it keeps everything; org settings stop applying). */
export async function removeOrgWorkspace(orgId: string, userId: string, workspaceId: string) {
  await requireOrgAdmin(orgId, userId);
  if ((await db.workspace.count({ where: { orgId } })) <= 1) throw new OrgError("The organization's last workspace can't be removed.");
  const { count } = await db.workspace.updateMany({ where: { id: workspaceId, orgId }, data: { orgId: null } });
  if (!count) throw new OrgError("Workspace not found in this organization.", 404);
}

function standardData(settings: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const k of Object.keys(STANDARD_KEYS) as StandardKey[]) if (k in settings) data[k] = settings[k];
  return data as { cloudAutoApprove?: boolean; previewSharing?: string; publishRequiresApproval?: boolean };
}

/** Set standardized values (pushed to every workspace now) and which keys are enforced. */
export async function setStandards(orgId: string, userId: string, settings: Record<string, unknown>, enforced: string[]) {
  await requireOrgAdmin(orgId, userId);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    const check = STANDARD_KEYS[k as StandardKey];
    if (!check) throw new OrgError(`${k} isn't a setting an organization can standardize.`);
    if (!check(v)) throw new OrgError(`That value isn't valid for ${k}.`);
    clean[k] = v;
  }
  const keys = enforced.filter((k) => k in clean);
  await db.organization.update({ where: { id: orgId }, data: { settings: clean as object, enforced: keys } });
  const data = standardData(clean);
  if (Object.keys(data).length) await db.workspace.updateMany({ where: { orgId }, data });
  for (const w of await db.workspace.findMany({ where: { orgId }, select: { id: true } })) {
    await audit(w.id, userId, "workspace.settings", `Organization standard settings applied: ${Object.keys(data).join(", ") || "none"}`);
  }
}

/** Refuse a workspace-level change to a setting its org enforces. */
export async function assertNotEnforced(workspaceId: string, key: StandardKey) {
  const org = await orgOf(workspaceId);
  if (org?.enforced.includes(key)) throw new OrgError(`Your organization sets this for every workspace.`, 403);
}

export async function enforcedKeys(workspaceId: string) {
  return (await orgOf(workspaceId))?.enforced ?? [];
}

/** Every workspace's audit events in one list, newest first. */
export async function orgAuditLog(orgId: string, userId: string, take = 200) {
  await requireOrgAdmin(orgId, userId);
  const workspaces = await db.workspace.findMany({ where: { orgId }, select: { id: true, name: true } });
  const all = (await Promise.all(workspaces.map(async (w) => (await auditLog(w.id, take)).map((e) => ({ ...e, workspace: w.name }))))).flat();
  return all.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""))).slice(0, take);
}
