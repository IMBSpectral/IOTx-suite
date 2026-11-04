import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import type { Role } from "@prisma/client";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { audit } from "./workspace-security";
import { sendPlatformEmail } from "./platform-email";
import { assertSeat } from "./members-extra";

/**
 * SCIM 2.0 provisioning: an identity provider (Okta, Entra ID, OneLogin…)
 * adds, updates and removes a workspace's members. It authenticates with the
 * workspace's SCIM token (rotate any time). New people get the default role,
 * or the role mapped from their IdP groups, and a welcome email.
 */

type Config = {
  tokenHash: string | null;
  tokenPrefix: string | null;
  tokenCreatedAt: string | null;
  defaultRole: Role;
  groupRoles: Record<string, Role>;
  welcomeEmail: boolean;
  groups: Record<string, { displayName: string; members: string[] }>;
};

export class ScimError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

const ROLES: Role[] = ["ADMIN", "MEMBER", "VIEWER"];
const RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1, VIEWER: 0 };
const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const file = (workspaceId: string) => path.join(PROJECTS_ROOT, "_forge", "scim", `${workspaceId.replace(/[^\w-]/g, "")}.json`);
const ORIGIN = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";

async function load(workspaceId: string): Promise<Config> {
  const raw = await fs.readFile(file(workspaceId), "utf8").catch(() => null);
  return { tokenHash: null, tokenPrefix: null, tokenCreatedAt: null, defaultRole: "MEMBER", groupRoles: {}, welcomeEmail: true, groups: {}, ...(raw ? (JSON.parse(raw) as Partial<Config>) : {}) };
}
async function save(workspaceId: string, c: Config) {
  await fs.mkdir(path.dirname(file(workspaceId)), { recursive: true });
  await fs.writeFile(file(workspaceId), JSON.stringify(c, null, 2));
}

// ── Settings (workspace admins) ───────────────────────────────────────────

export async function scimSettings(workspaceId: string) {
  const c = await load(workspaceId);
  return {
    enabled: !!c.tokenHash,
    tokenPrefix: c.tokenPrefix,
    tokenCreatedAt: c.tokenCreatedAt,
    defaultRole: c.defaultRole,
    groupRoles: c.groupRoles,
    welcomeEmail: c.welcomeEmail,
    baseUrl: `${ORIGIN}/scim/v2`,
    groups: Object.values(c.groups).map((g) => g.displayName),
  };
}

/** A new token (the old one stops working at once); shown once. */
export async function rotateToken(workspaceId: string) {
  const c = await load(workspaceId);
  const token = `scim_${crypto.randomBytes(24).toString("base64url")}`;
  c.tokenHash = hash(token);
  c.tokenPrefix = token.slice(0, 10);
  c.tokenCreatedAt = new Date().toISOString();
  await save(workspaceId, c);
  return token;
}

export async function disableScim(workspaceId: string) {
  const c = await load(workspaceId);
  c.tokenHash = c.tokenPrefix = c.tokenCreatedAt = null;
  await save(workspaceId, c);
}

export async function updateScimSettings(workspaceId: string, patch: { defaultRole?: string; groupRoles?: Record<string, string>; welcomeEmail?: boolean }) {
  const c = await load(workspaceId);
  if (patch.defaultRole !== undefined) {
    if (!ROLES.includes(patch.defaultRole as Role)) throw new ScimError("The default role is admin, member or viewer.");
    c.defaultRole = patch.defaultRole as Role;
  }
  if (patch.groupRoles) {
    const next: Record<string, Role> = {};
    for (const [g, r] of Object.entries(patch.groupRoles)) {
      if (!g.trim()) continue;
      if (!ROLES.includes(r as Role)) throw new ScimError(`${g}: the role is admin, member or viewer.`);
      next[g.trim()] = r as Role;
    }
    c.groupRoles = next;
  }
  if (typeof patch.welcomeEmail === "boolean") c.welcomeEmail = patch.welcomeEmail;
  await save(workspaceId, c);
}

// ── The SCIM API ──────────────────────────────────────────────────────────

/** The workspace a bearer token belongs to. */
export async function workspaceForToken(header: string | null) {
  const token = header?.match(/^Bearer\s+(scim_[\w-]+)$/i)?.[1];
  if (!token) return null;
  const h = hash(token);
  const dir = path.join(PROJECTS_ROOT, "_forge", "scim");
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    const c = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as Config;
    if (c.tokenHash && c.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(c.tokenHash), Buffer.from(h))) return f.replace(/\.json$/, "");
  }
  return null;
}

export const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

function userResource(u: { id: string; email: string; name: string | null }, active: boolean) {
  const [given, ...rest] = (u.name ?? "").split(" ");
  return {
    schemas: [SCHEMA_USER],
    id: u.id,
    userName: u.email,
    name: { givenName: given || undefined, familyName: rest.join(" ") || undefined, formatted: u.name ?? undefined },
    emails: [{ value: u.email, primary: true }],
    active,
    meta: { resourceType: "User", location: `${ORIGIN}/scim/v2/Users/${u.id}` },
  };
}

/** The role from IdP groups (highest mapped), or the default. */
function roleFor(c: Config, userId: string): Role {
  let best: Role | null = null;
  for (const g of Object.values(c.groups)) {
    const r = c.groupRoles[g.displayName];
    if (r && g.members.includes(userId) && (!best || RANK[r] > RANK[best])) best = r;
  }
  return best ?? c.defaultRole;
}

async function applyRole(workspaceId: string, userId: string, c: Config) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  // Owners are managed in Forge, never demoted by provisioning.
  if (!m || m.role === "OWNER") return;
  const role = roleFor(c, userId);
  if (role !== m.role) await db.membership.update({ where: { id: m.id }, data: { role } });
}

export async function listUsers(workspaceId: string, filter: string | null, startIndex = 1, count = 100) {
  const email = filter?.match(/^userName\s+eq\s+"([^"]+)"$/i)?.[1]?.toLowerCase();
  const members = await db.membership.findMany({
    where: { workspaceId, ...(email ? { user: { email } } : {}) },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const page = members.slice(Math.max(0, startIndex - 1), Math.max(0, startIndex - 1) + Math.min(200, count));
  return { schemas: [SCHEMA_LIST], totalResults: members.length, startIndex, itemsPerPage: page.length, Resources: page.map((m) => userResource(m.user, true)) };
}

export async function getUser(workspaceId: string, id: string) {
  const m = await db.membership.findFirst({ where: { workspaceId, userId: id }, include: { user: { select: { id: true, email: true, name: true } } } });
  if (!m) throw new ScimError("User not found", 404);
  return userResource(m.user, true);
}

type ScimUser = { userName?: string; name?: { givenName?: string; familyName?: string; formatted?: string }; displayName?: string; emails?: { value?: string; primary?: boolean }[]; active?: boolean };

export async function createUser(workspaceId: string, body: ScimUser) {
  const email = (body.userName ?? body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ScimError("userName must be an email address.");
  const name = body.name?.formatted || [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") || body.displayName || null;
  const c = await load(workspaceId);
  const user = await db.user.upsert({ where: { email }, create: { email, name }, update: name ? { name } : {} });
  const existing = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId } } });
  if (existing) throw new ScimError("That user is already in the workspace.", 409);
  if (body.active === false) return userResource(user, false);
  await assertSeat(workspaceId).catch((e: Error) => {
    throw new ScimError(e.message, 409);
  });
  await db.membership.create({ data: { userId: user.id, workspaceId, role: roleFor(c, user.id) } });
  await audit(workspaceId, null, "member.invited", `${email} was provisioned by SCIM`);
  if (c.welcomeEmail) {
    const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
    await sendPlatformEmail({
      to: email,
      subject: `You've been added to ${ws?.name ?? "a workspace"} on ${getBrand().name}`,
      text: `Your company added you to ${ws?.name ?? "its workspace"} on ${getBrand().name}, where you can build apps by describing them.\n\nSign in with your company account: ${ORIGIN}/login`,
    });
  }
  return userResource(user, true);
}

/** Deprovision: the person leaves the workspace (their account stays). Owners are never removed. */
async function deactivate(workspaceId: string, userId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
  if (!m) return;
  if (m.role === "OWNER") throw new ScimError("Workspace owners can't be removed by provisioning.", 400);
  await db.membership.delete({ where: { id: m.id } });
  const u = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  await audit(workspaceId, null, "member.removed", `${u?.email ?? userId} was deprovisioned by SCIM`);
}

export async function replaceUser(workspaceId: string, id: string, body: ScimUser) {
  const m = await db.membership.findFirst({ where: { workspaceId, userId: id } });
  if (!m) throw new ScimError("User not found", 404);
  const name = body.name?.formatted || [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") || body.displayName;
  if (name) await db.user.update({ where: { id }, data: { name } });
  if (body.active === false) {
    await deactivate(workspaceId, id);
    const u = await db.user.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, name: true } });
    return userResource(u, false);
  }
  return getUser(workspaceId, id);
}

type PatchOp = { op?: string; path?: string; value?: unknown };

export async function patchUser(workspaceId: string, id: string, ops: PatchOp[]) {
  for (const op of ops) {
    const v = op.value as Record<string, unknown> | boolean | undefined;
    const active = op.path === "active" ? v : typeof v === "object" && v && "active" in v ? v.active : undefined;
    if ((op.op ?? "").toLowerCase() === "replace" && (active === false || active === "False" || active === "false")) {
      await deactivate(workspaceId, id);
      const u = await db.user.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, name: true } });
      return userResource(u, false);
    }
  }
  return getUser(workspaceId, id);
}

export async function deleteUser(workspaceId: string, id: string) {
  await deactivate(workspaceId, id);
}

// Groups: kept for role mapping (group name → role).
function groupResource(id: string, g: { displayName: string; members: string[] }) {
  return { schemas: [SCHEMA_GROUP], id, displayName: g.displayName, members: g.members.map((value) => ({ value })), meta: { resourceType: "Group" } };
}

export async function listGroups(workspaceId: string, filter: string | null) {
  const c = await load(workspaceId);
  const name = filter?.match(/^displayName\s+eq\s+"([^"]+)"$/i)?.[1];
  const all = Object.entries(c.groups).filter(([, g]) => !name || g.displayName === name);
  return { schemas: [SCHEMA_LIST], totalResults: all.length, startIndex: 1, itemsPerPage: all.length, Resources: all.map(([id, g]) => groupResource(id, g)) };
}

export async function createGroup(workspaceId: string, body: { displayName?: string; members?: { value?: string }[] }) {
  const c = await load(workspaceId);
  const displayName = (body.displayName ?? "").trim();
  if (!displayName) throw new ScimError("displayName is required.");
  if (Object.values(c.groups).some((g) => g.displayName === displayName)) throw new ScimError("A group with that name exists.", 409);
  const id = crypto.randomUUID();
  c.groups[id] = { displayName, members: (body.members ?? []).map((m) => String(m.value ?? "")).filter(Boolean) };
  await save(workspaceId, c);
  for (const u of c.groups[id].members) await applyRole(workspaceId, u, c);
  return groupResource(id, c.groups[id]);
}

export async function patchGroup(workspaceId: string, id: string, ops: PatchOp[]) {
  const c = await load(workspaceId);
  const g = c.groups[id];
  if (!g) throw new ScimError("Group not found", 404);
  const before = new Set(g.members);
  for (const op of ops) {
    const kind = (op.op ?? "").toLowerCase();
    const values = Array.isArray(op.value) ? (op.value as { value?: string }[]).map((m) => String(m.value ?? "")) : [];
    if (kind === "add" && (op.path ?? "members") === "members") g.members = [...new Set([...g.members, ...values])];
    else if (kind === "remove" && op.path?.startsWith("members")) {
      const one = op.path.match(/value eq "([^"]+)"/)?.[1];
      g.members = one ? g.members.filter((m) => m !== one) : g.members.filter((m) => !values.includes(m));
    } else if (kind === "replace" && op.path === "members") g.members = values;
    else if (kind === "replace" && (op.path === "displayName" || (op.value && typeof op.value === "object" && "displayName" in (op.value as object)))) {
      g.displayName = String(op.path === "displayName" ? op.value : (op.value as { displayName: string }).displayName);
    }
  }
  await save(workspaceId, c);
  for (const u of new Set([...before, ...g.members])) await applyRole(workspaceId, u, c);
  return groupResource(id, g);
}

export async function deleteGroup(workspaceId: string, id: string) {
  const c = await load(workspaceId);
  const g = c.groups[id];
  if (!g) throw new ScimError("Group not found", 404);
  delete c.groups[id];
  await save(workspaceId, c);
  for (const u of g.members) await applyRole(workspaceId, u, c);
}
