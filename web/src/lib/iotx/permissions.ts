import { cookies } from "next/headers";
import type { PermRole } from "@prisma/client";
import { db } from "../db";
import { getBrand } from "../brand";
import { audit } from "../workspace-security";
import { workspaceGroups } from "../members-extra";
import type { BuiltinId, PlanId } from "./types";
import { PLAN_RANK, PLAN_LABEL, openKey } from "./types";
import { ALL_FEATURES, ALL_KEYS, FEATURE_BY_KEY, MANIFESTS, appOfKey, isKnownKey, keyLabel, manifestById } from "./manifests";
import {
  BUILTIN_DESC,
  BUILTIN_FOR_MEMBERSHIP,
  BUILTIN_NAMES,
  BUILTIN_ORDER,
  ROLE_TEMPLATES,
  builtinPerms,
  customRolePerms,
  templatePerms,
} from "./roles";
import { departmentChain } from "../structure";

/**
 * The IOTx Suite permission service. One rule for every app: a person can
 * do something only if the workspace's plan includes it, one of their roles
 * grants it (roles add up), the app is open to them, and nothing denies it.
 *
 *   can(userId, workspaceId, key)    -> boolean
 *   limit(userId, workspaceId, key)  -> number | null (null: no limit)
 *   appsFor(userId, workspaceId)     -> app ids they can open
 *   requirePerm(userId, workspaceId, key)  -> throws a 403 Response
 *
 * Owners always have everything their plan includes. Roles come from the
 * membership's built-in role (OWNER/ADMIN/MEMBER/VIEWER map to Owner, Admin,
 * Member, Guest), plus roles assigned to the person or to their groups. A
 * per-person deny wins over every grant; grants and denies can expire.
 * Results are cached for a few seconds and dropped on every change.
 */

export const PREVIEW_COOKIE = "iotx_preview";
const TTL_MS = 5_000;

export type Effective = {
  workspaceId: string;
  plan: PlanId;
  builtin: BuiltinId;
  isOwner: boolean;
  roles: { id: string; name: string; builtin: string | null }[];
  keys: string[];
  apps: string[];
  limits: Record<string, number | null>;
  /** Set while an admin is previewing the suite as a role. */
  preview: { roleId: string; name: string } | null;
};

export class PermissionError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

// On globalThis: route handlers and pages can load separate copies of this module, and a change
// made through one must drop the decisions cached by the other.
const G = globalThis as { __iotxPermCache?: Map<string, { exp: number; value: Effective | null }>; __iotxEnsured?: Set<string> };
const cache = (G.__iotxPermCache ??= new Map());
/** Drop every cached decision (after any role, assignment, override or membership change). */
export function invalidatePerms() {
  cache.clear();
}

// ── Built-in roles ──────────────────────────────────────────────────────────

const ensured = (G.__iotxEnsured ??= new Set<string>());
/** Create the four built-in roles for a workspace on first use. */
export async function ensureBuiltins(workspaceId: string) {
  if (ensured.has(workspaceId)) return;
  const have = await db.permRole.findMany({ where: { workspaceId, kind: "builtin" }, select: { builtin: true } });
  for (const b of BUILTIN_ORDER) {
    if (have.some((h) => h.builtin === b)) continue;
    await db.permRole
      .create({ data: { workspaceId, key: b, name: BUILTIN_NAMES[b], description: BUILTIN_DESC[b], kind: "builtin", builtin: b } })
      .catch(() => undefined); // created concurrently
  }
  ensured.add(workspaceId);
}

/** A role's full perms map: built-in defaults overlaid with what admins changed. */
export function resolvedPerms(role: Pick<PermRole, "builtin" | "perms">): Record<string, boolean> {
  const stored = (role.perms as Record<string, boolean> | null) ?? {};
  if (role.builtin === "owner") {
    const all: Record<string, boolean> = {};
    for (const k of ALL_KEYS) all[k] = true;
    return all;
  }
  if (role.builtin) return { ...builtinPerms(role.builtin as BuiltinId), ...stored };
  return { ...stored };
}

function roleLimits(role: Pick<PermRole, "builtin" | "limits">): Record<string, number> {
  if (role.builtin === "owner") return {};
  return (role.limits as Record<string, number> | null) ?? {};
}

const planOk = (plan: PlanId, key: string) => {
  const f = FEATURE_BY_KEY.get(key);
  return !f?.plan || PLAN_RANK[plan] >= PLAN_RANK[f.plan];
};

// ── Evaluation ──────────────────────────────────────────────────────────────

async function rolesFor(userId: string, workspaceId: string, membershipRole: string) {
  await ensureBuiltins(workspaceId);
  const builtin = BUILTIN_FOR_MEMBERSHIP[membershipRole] ?? "guest";
  const groups = (await workspaceGroups(workspaceId).catch(() => [])).filter((g) => g.members.includes(userId)).map((g) => g.id);
  // A role given to a department reaches everyone in it and in the departments under it.
  const depts = await departmentChain(userId, workspaceId).catch(() => []);
  const assigned = await db.permAssignment.findMany({
    where: {
      workspaceId,
      OR: [
        { subjectType: "user", subjectId: userId },
        ...(groups.length ? [{ subjectType: "group", subjectId: { in: groups } }] : []),
        ...(depts.length ? [{ subjectType: "department", subjectId: { in: depts } }] : []),
      ],
    },
    select: { roleId: true },
  });
  const roles = await db.permRole.findMany({
    where: { workspaceId, OR: [{ kind: "builtin", builtin }, { id: { in: [...new Set(assigned.map((a) => a.roleId))] } }] },
  });
  // The membership's built-in role first.
  roles.sort((a, b) => (a.builtin === builtin ? -1 : b.builtin === builtin ? 1 : a.name.localeCompare(b.name)));
  return { builtin, roles };
}

function combine(
  workspaceId: string,
  plan: PlanId,
  builtin: BuiltinId,
  roles: PermRole[],
  overrides: { key: string; effect: string }[],
  preview: Effective["preview"],
): Effective {
  const isOwner = roles.some((r) => r.builtin === "owner");
  const keys = new Set<string>();
  // A role's features count only for apps that role itself opens: turning Builder off in one
  // role doesn't leak that role's builder switches when another role opens the Builder.
  // A person-level grant of an app ("Builder until Friday") opens it for each of their roles.
  const grantedApps = new Set(
    isOwner ? [] : overrides.filter((o) => o.effect === "grant" && o.key.endsWith(".open")).map((o) => o.key.slice(0, -5)),
  );
  for (const r of roles) {
    const p = resolvedPerms(r);
    for (const [k, on] of Object.entries(p)) {
      if (!on || !ALL_KEYS.has(k) || FEATURE_BY_KEY.get(k)?.type === "limit") continue;
      const app = appOfKey(k);
      if (!k.endsWith(".open") && !manifestById(app)?.alwaysOpen && !p[openKey(app)] && !grantedApps.has(app)) continue;
      keys.add(k);
    }
  }
  if (!isOwner) {
    for (const o of overrides) if (o.effect === "grant" && ALL_KEYS.has(o.key)) keys.add(o.key);
    for (const o of overrides) if (o.effect === "deny") keys.delete(o.key);
  }
  // Plan ceiling, then app access: a feature of an app that's closed is unreachable.
  for (const k of [...keys]) {
    if (!planOk(plan, k)) keys.delete(k);
  }
  // Apps switched off on this server (IOTX_DISABLED_APPS, e.g. "insights") are closed for everyone, owners too.
  for (const k of [...keys]) if (SERVER_OFF.has(appOfKey(k))) keys.delete(k);
  const open = (app: string) => !SERVER_OFF.has(app) && (!!manifestById(app)?.alwaysOpen || keys.has(openKey(app)));
  for (const k of [...keys]) {
    if (!k.endsWith(".open") && !open(appOfKey(k))) keys.delete(k);
  }
  const apps = MANIFESTS.filter((m) => open(m.id)).map((m) => m.id);
  // Limits add up like grants: the most generous of the roles that open the app; any role without one means no limit.
  const limits: Record<string, number | null> = {};
  for (const f of ALL_FEATURES) {
    if (f.type !== "limit") continue;
    const app = appOfKey(f.key);
    if (!open(app)) continue;
    if (isOwner) {
      limits[f.key] = null;
      continue;
    }
    let best: number | null | undefined;
    for (const r of roles) {
      const p = resolvedPerms(r);
      if (!manifestById(app)?.alwaysOpen && !p[openKey(app)]) continue;
      const v = roleLimits(r)[f.key];
      if (v === undefined || v === null) best = null;
      else if (best !== null) best = Math.max(best ?? 0, v);
    }
    limits[f.key] = best === undefined ? null : best;
  }
  return {
    workspaceId,
    plan,
    builtin,
    isOwner,
    roles: roles.map((r) => ({ id: r.id, name: r.name, builtin: r.builtin })),
    keys: [...keys].sort(),
    apps,
    limits,
    preview,
  };
}

/** Everything one person can do in a workspace (null when they aren't a member). */
export async function effective(userId: string, workspaceId: string, previewRoleId?: string | null): Promise<Effective | null> {
  // The membership is read every time (one small query), so a role change or removal applies at once.
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true, workspace: { select: { plan: true } } },
  });
  const version = (globalThis as { __iotxPermsVersion?: number }).__iotxPermsVersion ?? 0;
  const ck = `${userId}:${workspaceId}:${previewRoleId ?? ""}:${membership?.role ?? "-"}:${membership?.workspace.plan ?? ""}:${version}`;
  const hit = cache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.value;
  let value: Effective | null = null;
  if (membership) {
    const plan = membership.workspace.plan as PlanId;
    if (previewRoleId) {
      await ensureBuiltins(workspaceId);
      const role = await db.permRole.findFirst({ where: { id: previewRoleId, workspaceId } });
      if (role) value = combine(workspaceId, plan, (role.builtin as BuiltinId) ?? "guest", [role], [], { roleId: role.id, name: role.name });
    }
    if (!value) {
      const { builtin, roles } = await rolesFor(userId, workspaceId, membership.role);
      const now = new Date();
      const overrides = await db.permOverride.findMany({
        where: { workspaceId, userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { key: true, effect: true, expiresAt: true },
      });
      value = combine(workspaceId, plan, builtin, roles, overrides, null);
      // A temporary grant or deny that ends sooner than the cache would shortens it.
      const soonest = overrides.reduce((t, o) => (o.expiresAt && o.expiresAt.getTime() < t ? o.expiresAt.getTime() : t), Infinity);
      cache.set(ck, { exp: Math.min(Date.now() + TTL_MS, soonest), value });
      return value;
    }
  }
  cache.set(ck, { exp: Date.now() + TTL_MS, value });
  return value;
}

/** The preview role chosen with "Preview as", honoured only for people who manage roles. */
async function previewRoleFor(userId: string, workspaceId: string) {
  let id: string | undefined;
  try {
    id = (await cookies()).get(PREVIEW_COOKIE)?.value;
  } catch {
    return null; // outside a request (worker, scripts)
  }
  if (!id) return null;
  return (await canManageRoles(userId, workspaceId)) ? id : null;
}

/** As effective(), but following "Preview as" when the caller set it. Use this for anything the person sees or does. */
export async function effectiveForRequest(userId: string, workspaceId: string) {
  return effective(userId, workspaceId, await previewRoleFor(userId, workspaceId));
}

/** Whether a person may use a feature (or open an app, with "<app>.open"). Follows "Preview as". */
export async function can(userId: string, workspaceId: string, key: string) {
  if (!isKnownKey(key) && !manifestById(key.replace(/\.open$/, ""))?.alwaysOpen) return false;
  const e = await effectiveForRequest(userId, workspaceId);
  if (!e) return false;
  if (key.endsWith(".open") && manifestById(key.slice(0, -5))?.alwaysOpen) return true;
  return e.keys.includes(key);
}

/** A numeric limit: a number, or null for no limit (or when the app isn't open, 0). */
export async function limit(userId: string, workspaceId: string, key: string): Promise<number | null> {
  const e = await effectiveForRequest(userId, workspaceId);
  if (!e) return 0;
  return key in e.limits ? e.limits[key] : 0;
}

export async function appsFor(userId: string, workspaceId: string) {
  return (await effectiveForRequest(userId, workspaceId))?.apps ?? [];
}

/** Apps this server doesn't offer at all, from IOTX_DISABLED_APPS (comma-separated app ids). */
export const SERVER_OFF = new Set((process.env.IOTX_DISABLED_APPS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

const refusedAt = new Map<string, number>();

/** The 403 reply for a refused feature, with a message the UI can show as is. */
export function denied(key: string) {
  const label = keyLabel(key).replace(/\bIOTx\b/g, getBrand().shortName);
  const f = FEATURE_BY_KEY.get(key);
  const msg = key === "builder.open"
    ? "Building isn't turned on for your role. You can still chat with the AI; ask an admin to turn on Builder."
    : `Your role doesn't include "${label}". Ask an admin to turn it on.`;
  return Response.json({ error: msg, permission: key, code: "permission_denied", plan: f?.plan ?? null }, { status: 403 });
}

/**
 * Refuse unless the person has every key listed. Throws a 403 Response
 * (route() hands it back as the reply). Refusals are written to the audit
 * log at most once a minute per person and key.
 */
export async function requirePerm(userId: string, workspaceId: string, ...keys: string[]) {
  for (const key of keys) {
    if (await can(userId, workspaceId, key)) continue;
    // Builder features refused because Builder itself is off say so.
    const app = appOfKey(key);
    const shown = !key.endsWith(".open") && !(await can(userId, workspaceId, openKey(app))) && !manifestById(app)?.alwaysOpen ? openKey(app) : key;
    const rk = `${userId}:${workspaceId}:${shown}`;
    if ((refusedAt.get(rk) ?? 0) < Date.now() - 60_000) {
      refusedAt.set(rk, Date.now());
      void audit(workspaceId, userId, "permissions.refused", `Refused: ${keyLabel(shown)} (${shown})`);
    }
    throw denied(shown);
  }
}

/** As requirePerm, for the workspace a project belongs to. */
export async function requireProjectPerm(userId: string, projectId: string, ...keys: string[]) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!p) throw new Response("Not found", { status: 404 });
  await requirePerm(userId, p.workspaceId, ...keys);
}

/** Which build mode needs which switch: Ask is chat (everyone with Ask IOTx); the rest change the app. */
export function keyForMode(mode: string | undefined) {
  if (mode === "ask") return "home.ask";
  if (mode === "plan") return "builder.plan";
  return "builder.build";
}

/** Which Cloud switch an action or view of the Cloud manager needs (builder.cloud.enable otherwise). */
const CLOUD_KEYS: Record<string, string> = {
  // actions
  createUser: "builder.cloud.users", deleteUser: "builder.cloud.users", setPassword: "builder.cloud.users", setAuth: "builder.cloud.users",
  insertRow: "builder.cloud.rows", updateRow: "builder.cloud.rows", deleteRow: "builder.cloud.rows", policy: "builder.cloud.rows",
  emailExport: "builder.cloud.rows",
  sql: "builder.cloud.sql", backup: "builder.cloud.sql", restore: "builder.cloud.sql", deleteBackup: "builder.cloud.sql",
  createBucket: "builder.cloud.storage", deleteBucket: "builder.cloud.storage", uploadFile: "builder.cloud.storage", deleteFile: "builder.cloud.storage", signUrl: "builder.cloud.storage",
  startRun: "builder.cloud.jobs", approveRun: "builder.cloud.jobs", rejectRun: "builder.cloud.jobs", sendEvent: "builder.cloud.jobs", cancelRun: "builder.cloud.jobs", retryRun: "builder.cloud.jobs",
  createJob: "builder.cloud.jobs", updateJob: "builder.cloud.jobs", deleteJob: "builder.cloud.jobs", runJob: "builder.cloud.jobs",
  deployFunctions: "builder.cloud.functions", invokeFunction: "builder.cloud.functions",
  setSecret: "builder.cloud.secrets", deleteSecret: "builder.cloud.secrets",
  // views
  "view:users": "builder.cloud.users", "view:rows": "builder.cloud.rows", "view:tables": "builder.cloud.rows", "view:export": "builder.cloud.rows",
  "view:backups": "builder.cloud.sql", "view:storage": "builder.cloud.storage", "view:files": "builder.cloud.storage", "view:file": "builder.cloud.storage",
  "view:functions": "builder.cloud.functions", "view:fnLogs": "builder.cloud.functions", "view:fnSource": "builder.cloud.functions",
  "view:jobs": "builder.cloud.jobs", "view:jobRuns": "builder.cloud.jobs", "view:workflows": "builder.cloud.jobs", "view:run": "builder.cloud.jobs",
};
export function cloudKey(actionOrView: string | null | undefined, view = false) {
  if (!actionOrView) return view ? "builder.open" : "builder.cloud.enable";
  return CLOUD_KEYS[view ? `view:${actionOrView}` : actionOrView] ?? (view ? "builder.open" : "builder.cloud.enable");
}

/** AI credits this person spent in the workspace this calendar month. */
export async function creditsSpentThisMonth(userId: string, workspaceId: string) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const r = await db.creditEntry.aggregate({ where: { workspaceId, userId, delta: { lt: 0 }, createdAt: { gte: start } }, _sum: { delta: true } });
  return -(r._sum.delta ?? 0);
}

/** Refuse when the person's role caps their monthly AI credits and they've reached it. */
export async function assertCreditLimit(userId: string, workspaceId: string) {
  const cap = await limit(userId, workspaceId, "builder.credits.monthly");
  if (cap === null) return;
  const spent = await creditsSpentThisMonth(userId, workspaceId);
  if (spent >= cap) {
    throw Response.json(
      { error: `You've used your role's ${cap} AI credits for this month. Ask an admin to raise "AI credits per month".`, permission: "builder.credits.monthly", code: "limit_reached", limit: cap, spent },
      { status: 402 },
    );
  }
}

// ── Managing roles ──────────────────────────────────────────────────────────

/** Owners always; anyone else whose own (non-preview) roles include admin.roles. */
export async function canManageRoles(userId: string, workspaceId: string) {
  const e = await effective(userId, workspaceId);
  return !!e && (e.isOwner || e.keys.includes("admin.roles"));
}

async function requireManager(userId: string, workspaceId: string) {
  if (!(await canManageRoles(userId, workspaceId))) {
    void audit(workspaceId, userId, "permissions.refused", "Refused: Manage roles and permissions (admin.roles)");
    throw new PermissionError('Managing roles needs "Manage roles and permissions". Ask the owner.', 403);
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "role";

async function changed(workspaceId: string, actorId: string, detail: string) {
  invalidatePerms();
  await audit(workspaceId, actorId, "permissions.changed", detail);
}

async function roleIn(workspaceId: string, roleId: string) {
  const r = await db.permRole.findFirst({ where: { id: roleId, workspaceId } });
  if (!r) throw new PermissionError("Role not found.", 404);
  return r;
}

/** A new custom role: from scratch (Ask only), from a template, or copied from another role. */
export async function createRole(workspaceId: string, actorId: string, input: { name?: string; template?: string; copyFrom?: string; description?: string }) {
  await requireManager(actorId, workspaceId);
  await ensureBuiltins(workspaceId);
  const tpl = input.template ? ROLE_TEMPLATES.find((t) => t.id === input.template) : undefined;
  if (input.template && !tpl) throw new PermissionError("No such template.");
  const source = input.copyFrom ? await roleIn(workspaceId, input.copyFrom) : null;
  const name = (input.name?.trim() || tpl?.name || (source ? `${source.name} (copy)` : "New role")).slice(0, 60);
  const perms = tpl ? templatePerms(tpl) : source ? resolvedPerms(source) : customRolePerms();
  const limits = tpl?.limits ?? (source ? roleLimits(source) : {});
  const scopes = tpl?.scopes ?? ((source?.scopes as Record<string, string> | null) ?? {});
  let key = slug(name);
  for (let i = 2; await db.permRole.findUnique({ where: { workspaceId_key: { workspaceId, key } } }); i++) key = `${slug(name)}-${i}`;
  const role = await db.permRole.create({
    data: {
      workspaceId,
      key,
      name,
      description: (input.description ?? tpl?.description ?? source?.description ?? null)?.slice(0, 200) ?? null,
      kind: tpl ? "template" : "custom",
      template: tpl?.id ?? null,
      perms,
      limits,
      scopes,
    },
  });
  await changed(workspaceId, actorId, `Created the role ${name}${tpl ? ` from the ${tpl.name} template` : source ? ` as a copy of ${source.name}` : ""}`);
  return role;
}

/** Change a role: name, description, switches (true/false), limits (number or null) and scopes. */
export async function updateRole(
  workspaceId: string,
  actorId: string,
  roleId: string,
  patch: { name?: string; description?: string | null; set?: Record<string, boolean>; limits?: Record<string, number | null>; scopes?: Record<string, string> },
) {
  await requireManager(actorId, workspaceId);
  const role = await roleIn(workspaceId, roleId);
  if (role.builtin === "owner") throw new PermissionError("The Owner role always has everything and can't be changed.", 400);
  const perms = { ...((role.perms as Record<string, boolean> | null) ?? {}) };
  const notes: string[] = [];
  for (const [k, v] of Object.entries(patch.set ?? {})) {
    if (!isKnownKey(k)) throw new PermissionError(`Unknown permission ${k}.`);
    if (FEATURE_BY_KEY.get(k)?.type === "limit") throw new PermissionError(`${k} is a limit; set it under limits.`);
    perms[k] = !!v;
    notes.push(`${keyLabel(k)} ${v ? "on" : "off"}`);
  }
  const limits = { ...roleLimits(role) } as Record<string, number>;
  for (const [k, v] of Object.entries(patch.limits ?? {})) {
    if (FEATURE_BY_KEY.get(k)?.type !== "limit") throw new PermissionError(`${k} isn't a limit.`);
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) {
      delete limits[k];
      notes.push(`${keyLabel(k)}: no limit`);
    } else {
      if (typeof v !== "number" || v < 0 || !Number.isFinite(v)) throw new PermissionError("Limits are zero or more.");
      limits[k] = Math.floor(v);
      notes.push(`${keyLabel(k)}: ${Math.floor(v)}`);
    }
  }
  const scopes = { ...((role.scopes as Record<string, string> | null) ?? {}) };
  for (const [k, v] of Object.entries(patch.scopes ?? {})) {
    const scope = MANIFESTS.flatMap((m) => m.scopes ?? []).find((s) => s.key === k);
    if (!scope) throw new PermissionError(`Unknown scope ${k}.`);
    if (!scope.options.includes(v)) throw new PermissionError(`That isn't an option for ${scope.label}.`);
    scopes[k] = v;
    notes.push(`${scope.label}: ${v}`);
  }
  const data: Record<string, unknown> = { perms, limits, scopes };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new PermissionError("Name the role.");
    if (role.builtin) throw new PermissionError("Built-in roles keep their names.");
    data.name = patch.name.trim().slice(0, 60);
    notes.push(`renamed to ${data.name}`);
  }
  if (patch.description !== undefined) data.description = patch.description?.slice(0, 200) ?? null;
  const updated = await db.permRole.update({ where: { id: role.id }, data });
  await changed(workspaceId, actorId, `Role ${role.name}: ${notes.join(", ") || "updated"}`.slice(0, 500));
  return updated;
}

/** Reset a built-in role to its defaults. */
export async function resetRole(workspaceId: string, actorId: string, roleId: string) {
  await requireManager(actorId, workspaceId);
  const role = await roleIn(workspaceId, roleId);
  if (!role.builtin || role.builtin === "owner") throw new PermissionError("Only built-in roles can be reset.");
  await db.permRole.update({ where: { id: role.id }, data: { perms: {}, limits: {}, scopes: {} } });
  await changed(workspaceId, actorId, `Role ${role.name} reset to its defaults`);
}

export async function deleteRole(workspaceId: string, actorId: string, roleId: string) {
  await requireManager(actorId, workspaceId);
  const role = await roleIn(workspaceId, roleId);
  if (role.builtin) throw new PermissionError("Built-in roles can't be deleted.");
  await db.permRole.delete({ where: { id: role.id } });
  await changed(workspaceId, actorId, `Deleted the role ${role.name}`);
}

/** Give a role to a person or a group. Built-in roles come from the membership, not from here. */
export async function assignRole(workspaceId: string, actorId: string, roleId: string, subjectType: "user" | "group" | "department", subjectId: string) {
  await requireManager(actorId, workspaceId);
  const role = await roleIn(workspaceId, roleId);
  if (role.builtin) throw new PermissionError("Built-in roles follow the person's workspace role; change that in Members.");
  let who = subjectId;
  if (subjectType === "user") {
    const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: subjectId, workspaceId } }, include: { user: { select: { email: true } } } });
    if (!m) throw new PermissionError("That person isn't in this workspace.", 404);
    who = m.user.email;
  } else if (subjectType === "department") {
    const d = await db.department.findFirst({ where: { id: subjectId, workspaceId } });
    if (!d) throw new PermissionError("Department not found.", 404);
    who = `the ${d.name} department (and everyone under it)`;
  } else {
    const g = (await workspaceGroups(workspaceId)).find((x) => x.id === subjectId);
    if (!g) throw new PermissionError("Group not found.", 404);
    who = `the group ${g.name}`;
  }
  await db.permAssignment.upsert({
    where: { roleId_subjectType_subjectId: { roleId, subjectType, subjectId } },
    create: { workspaceId, roleId, subjectType, subjectId, createdById: actorId },
    update: {},
  });
  await changed(workspaceId, actorId, `Gave ${role.name} to ${who}`);
}

export async function unassignRole(workspaceId: string, actorId: string, roleId: string, subjectType: "user" | "group" | "department", subjectId: string) {
  await requireManager(actorId, workspaceId);
  const role = await roleIn(workspaceId, roleId);
  await db.permAssignment.deleteMany({ where: { workspaceId, roleId, subjectType, subjectId } });
  await changed(workspaceId, actorId, `Took ${role.name} from ${subjectType} ${subjectId}`);
}

/** A per-person deny or (temporary) grant. */
export async function addOverride(
  workspaceId: string,
  actorId: string,
  input: { userId: string; key: string; effect: "deny" | "grant"; expiresAt?: string | null; reason?: string },
) {
  await requireManager(actorId, workspaceId);
  if (!isKnownKey(input.key)) throw new PermissionError(`Unknown permission ${input.key}.`);
  if (FEATURE_BY_KEY.get(input.key)?.type === "limit") throw new PermissionError("Limits are set on roles.");
  if (input.effect !== "deny" && input.effect !== "grant") throw new PermissionError("Choose deny or grant.");
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: input.userId, workspaceId } }, include: { user: { select: { email: true } } } });
  if (!m) throw new PermissionError("That person isn't in this workspace.", 404);
  if (m.role === "OWNER") throw new PermissionError("The owner always has everything.");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) throw new PermissionError("Pick a time in the future.");
  // One rule per person and key.
  await db.permOverride.deleteMany({ where: { workspaceId, userId: input.userId, key: input.key } });
  const o = await db.permOverride.create({
    data: { workspaceId, userId: input.userId, key: input.key, effect: input.effect, expiresAt, reason: input.reason?.slice(0, 200) || null, createdById: actorId },
  });
  await changed(
    workspaceId,
    actorId,
    `${input.effect === "deny" ? "Denied" : "Granted"} ${keyLabel(input.key)} for ${m.user.email}${expiresAt ? ` until ${expiresAt.toISOString()}` : ""}`,
  );
  return o;
}

export async function removeOverride(workspaceId: string, actorId: string, id: string) {
  await requireManager(actorId, workspaceId);
  const o = await db.permOverride.findFirst({ where: { id, workspaceId } });
  if (!o) throw new PermissionError("Not found.", 404);
  await db.permOverride.delete({ where: { id } });
  await changed(workspaceId, actorId, `Removed the ${o.effect} of ${keyLabel(o.key)} for ${o.userId}`);
}

/** Everything the Roles & permissions screen shows. */
export async function adminState(workspaceId: string, actorId: string) {
  await requireManager(actorId, workspaceId);
  await ensureBuiltins(workspaceId);
  const [ws, roles, assignments, overrides, members, groups] = await Promise.all([
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { plan: true, name: true } }),
    db.permRole.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    db.permAssignment.findMany({ where: { workspaceId } }),
    db.permOverride.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }),
    db.membership.findMany({ where: { workspaceId }, include: { user: { select: { id: true, email: true, name: true } } }, orderBy: { createdAt: "asc" } }),
    workspaceGroups(workspaceId).catch(() => []),
  ]);
  const [depts, profiles] = await Promise.all([
    db.department.findMany({ where: { workspaceId }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true, parentId: true } }),
    db.employeeProfile.findMany({ where: { workspaceId, departmentId: { not: null } }, select: { departmentId: true } }),
  ]);
  const order = (r: PermRole) => (r.builtin ? BUILTIN_ORDER.indexOf(r.builtin as BuiltinId) : 10);
  roles.sort((a, b) => order(a) - order(b));
  const now = Date.now();
  return {
    plan: ws.plan as PlanId,
    planLabel: PLAN_LABEL[ws.plan as PlanId],
    workspaceName: ws.name,
    roles: roles.map((r) => {
      const perms = resolvedPerms(r);
      return {
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        kind: r.kind,
        builtin: r.builtin,
        template: r.template,
        locked: r.builtin === "owner",
        perms,
        limits: roleLimits(r),
        scopes: (r.scopes as Record<string, string> | null) ?? {},
        count: Object.values(perms).filter(Boolean).length,
        people: r.builtin
          ? members.filter((m) => BUILTIN_FOR_MEMBERSHIP[m.role] === r.builtin).length
          : assignments.filter((a) => a.roleId === r.id).length,
      };
    }),
    assignments: assignments.map((a) => ({ id: a.id, roleId: a.roleId, subjectType: a.subjectType, subjectId: a.subjectId })),
    overrides: overrides.map((o) => ({
      id: o.id,
      userId: o.userId,
      key: o.key,
      label: keyLabel(o.key).replace(/\bIOTx\b/g, getBrand().shortName),
      effect: o.effect,
      expiresAt: o.expiresAt?.toISOString() ?? null,
      expired: !!o.expiresAt && o.expiresAt.getTime() <= now,
      reason: o.reason,
    })),
    members: members.map((m) => ({ userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, builtin: BUILTIN_FOR_MEMBERSHIP[m.role] })),
    groups: groups.map((g) => ({ id: g.id, name: g.name, members: g.members.length })),
    departments: depts.map((d) => {
      const path: string[] = [];
      for (let at: (typeof depts)[number] | undefined = d; at && path.length < 8; at = depts.find((x) => x.id === at!.parentId)) path.unshift(at.name);
      return { id: d.id, name: path.join(" › "), members: profiles.filter((p) => p.departmentId === d.id).length };
    }),
    templates: ROLE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })),
  };
}
