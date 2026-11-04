import crypto from "node:crypto";
import { db } from "./db";
import { audit } from "./workspace-security";
import { PermissionError } from "./iotx/permissions";
import { requireProject } from "./workspace";
import { getCloud, listTables, rest, CloudError, type CloudConfig } from "./cloud";
import { linkedSheets, readLinked } from "./linked-sheets";
import { GoogleError } from "./google";

/**
 * Data Hub: one app's data, read by other apps in the same workspace.
 *
 * The owner of an app shares one of its tables (Forge Cloud) or linked
 * Google Sheets under a short name. Another app connects to the share and
 * gets its own read key; its pages read through GET /api/hub/<share> with
 * header x-hub-key. Reads are read-only, filtered and capped; a key can be
 * revoked at any time, and deleting a share cuts every app off. Sharing
 * needs edit rights on the source app; connecting needs edit rights on the
 * reading app, and the share must be open to all apps or list that app.
 */

const origin = () => (process.env.EDITOR_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const NAME = /^[a-z][a-z0-9_-]{1,39}$/;
const MAX_ROWS = 1000;

export type ShareDto = Awaited<ReturnType<typeof listShares>>[number];

/** Every share in the workspace, with its source app and the apps connected to it. */
export async function listShares(userId: string, workspaceId: string) {
  const shares = await db.dataShare.findMany({ where: { workspaceId }, include: { grants: { where: { revokedAt: null } } }, orderBy: { name: "asc" } });
  const ids = [...new Set(shares.flatMap((s) => [s.sourceProjectId, ...s.grants.map((g) => g.projectId)]))];
  const projects = await db.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const name = new Map(projects.map((p) => [p.id, p.name]));
  const manage = new Map(await Promise.all(shares.map(async (s) => [s.id, await canManageShare(userId, workspaceId, s)] as const)));
  return shares.map((s) => ({
    id: s.id,
    name: s.name,
    label: s.label,
    description: s.description,
    kind: s.kind,
    ref: s.ref,
    openToAll: s.openToAll,
    source: { id: s.sourceProjectId, name: name.get(s.sourceProjectId) ?? "(deleted app)" },
    mine: s.createdById === userId,
    canManage: manage.get(s.id) ?? false,
    apps: s.grants.map((g) => ({ grantId: g.id, projectId: g.projectId, name: name.get(g.projectId) ?? "(deleted app)", lastUsedAt: g.lastUsedAt?.toISOString() ?? null })),
    url: `${origin()}/api/hub/${s.id}`,
  }));
}

/** What an app could share: its Forge Cloud tables and its linked sheets. */
export async function shareable(userId: string, projectId: string) {
  await requireProject(userId, projectId, "edit");
  const [cfg, sheets] = await Promise.all([getCloud(projectId), linkedSheets(projectId)]);
  const tables = cfg?.enabled ? (await listTables(projectId).catch(() => [])).map((t) => t.name) : [];
  return { tables, sheets: sheets.map((s) => ({ id: s.spreadsheetId, name: s.name })) };
}

export async function createShare(
  userId: string,
  workspaceId: string,
  b: { name?: unknown; label?: unknown; description?: unknown; projectId?: unknown; kind?: unknown; ref?: unknown; openToAll?: unknown },
) {
  const projectId = String(b.projectId ?? "");
  const p = await requireProject(userId, projectId, "edit").catch(() => null);
  if (!p || p.workspaceId !== workspaceId) throw new PermissionError("You need edit rights on that app to share its data.", 403);
  const name = String(b.name ?? "").trim().toLowerCase();
  if (!NAME.test(name)) throw new PermissionError("Name: 2–40 lowercase letters, numbers, - or _, starting with a letter (e.g. customers).");
  const kind = b.kind === "sheet" ? "sheet" : "table";
  const ref = String(b.ref ?? "");
  const can = await shareable(userId, projectId);
  if (kind === "table" ? !can.tables.includes(ref) : !can.sheets.some((s) => s.id === ref)) throw new PermissionError(kind === "table" ? "That app has no such table." : "That sheet isn't linked to that app.");
  if (await db.dataShare.findUnique({ where: { workspaceId_name: { workspaceId, name } } })) throw new PermissionError(`"${name}" is already used. Pick another name.`);
  const s = await db.dataShare.create({
    data: {
      workspaceId,
      name,
      label: String(b.label ?? "").trim().slice(0, 80) || name,
      description: typeof b.description === "string" ? b.description.trim().slice(0, 300) || null : null,
      sourceProjectId: projectId,
      kind,
      ref,
      openToAll: b.openToAll === true,
      createdById: userId,
    },
  });
  await audit(workspaceId, userId, "people.changed", `Shared ${kind} ${ref} of ${p.name} to the Data Hub as "${name}"`);
  return s;
}

async function shareIn(workspaceId: string, id: string) {
  const s = await db.dataShare.findFirst({ where: { workspaceId, OR: [{ id }, { name: id }] } });
  if (!s) throw new PermissionError("That share doesn't exist.", 404);
  return s;
}
async function canManageShare(userId: string, workspaceId: string, s: { createdById: string; sourceProjectId: string }) {
  if (s.createdById === userId) return true;
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } });
  if (m?.role === "OWNER" || m?.role === "ADMIN") return true;
  return !!(await requireProject(userId, s.sourceProjectId, "edit").catch(() => null));
}

export async function updateShare(userId: string, workspaceId: string, id: string, b: { label?: unknown; description?: unknown; openToAll?: unknown; allow?: unknown }) {
  const s = await shareIn(workspaceId, id);
  if (!(await canManageShare(userId, workspaceId, s))) throw new PermissionError("Only the app's editors or an admin can change this share.", 403);
  const out = await db.dataShare.update({
    where: { id: s.id },
    data: {
      ...(typeof b.label === "string" && b.label.trim() ? { label: b.label.trim().slice(0, 80) } : {}),
      ...(typeof b.description === "string" ? { description: b.description.trim().slice(0, 300) || null } : {}),
      ...(typeof b.openToAll === "boolean" ? { openToAll: b.openToAll } : {}),
    },
  });
  // The owner can let a specific app in, even when the share isn't open to all.
  if (typeof b.allow === "string" && b.allow) await grant(userId, workspaceId, s.id, b.allow, true);
  return out;
}

export async function deleteShare(userId: string, workspaceId: string, id: string) {
  const s = await shareIn(workspaceId, id);
  if (!(await canManageShare(userId, workspaceId, s))) throw new PermissionError("Only the app's editors or an admin can delete this share.", 403);
  await db.dataShare.delete({ where: { id: s.id } });
  await audit(workspaceId, userId, "people.changed", `Removed "${s.name}" from the Data Hub`);
}

/** Connect an app to a share: returns its read key (made once; the same key on repeat). */
export async function grant(userId: string, workspaceId: string, shareId: string, projectId: string, byOwner = false) {
  const s = await shareIn(workspaceId, shareId);
  const p = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, workspaceId: true } });
  if (!p || p.workspaceId !== workspaceId) throw new PermissionError("That app isn't in this workspace.", 404);
  if (!byOwner) {
    if (!(await requireProject(userId, projectId, "edit").catch(() => null))) throw new PermissionError("You need edit rights on the app that will read the data.", 403);
    if (!s.openToAll && !(await canManageShare(userId, workspaceId, s))) throw new PermissionError(`"${s.name}" is shared only with apps its owner picks. Ask them to add ${p.name}.`, 403);
  }
  if (projectId === s.sourceProjectId) throw new PermissionError("That app already owns this data.");
  const existing = await db.dataGrant.findUnique({ where: { shareId_projectId: { shareId: s.id, projectId } } });
  if (existing && !existing.revokedAt) return existing;
  const key = `hub_${crypto.randomBytes(24).toString("base64url")}`;
  const g = existing
    ? await db.dataGrant.update({ where: { id: existing.id }, data: { key, revokedAt: null, createdById: userId } })
    : await db.dataGrant.create({ data: { shareId: s.id, projectId, key, createdById: userId } });
  await audit(workspaceId, userId, "people.changed", `Connected ${p.name} to "${s.name}" in the Data Hub`);
  return g;
}

export async function revoke(userId: string, workspaceId: string, grantId: string) {
  const g = await db.dataGrant.findUnique({ where: { id: grantId }, include: { share: true } });
  if (!g || g.share.workspaceId !== workspaceId) throw new PermissionError("Not found.", 404);
  const reader = await requireProject(userId, g.projectId, "edit").catch(() => null);
  if (!reader && !(await canManageShare(userId, workspaceId, g.share))) throw new PermissionError("Only the share's owner or the reading app's editors can disconnect it.", 403);
  await db.dataGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } });
  await audit(workspaceId, userId, "people.changed", `Disconnected an app from "${g.share.name}"`);
}

export class HubError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** The gateway: read a share with an app's key. Filters like ?status=eq.open&order=created_at.desc&limit=50. */
export async function readShare(shareRef: string, key: string | null, params: URLSearchParams) {
  if (!key) throw new HubError("Send the app's Data Hub key in the x-hub-key header.", 401);
  const g = await db.dataGrant.findUnique({ where: { key }, include: { share: true } });
  if (!g || g.revokedAt || (g.share.id !== shareRef && g.share.name !== shareRef)) throw new HubError("That key can't read this data (it may have been disconnected).", 403);
  void db.dataGrant.update({ where: { id: g.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  const s = g.share;
  if (s.kind === "sheet") {
    try {
      const data = await readLinked(s.sourceProjectId, s.ref, params.get("range") ?? undefined);
      if (!data) throw new HubError("The source app no longer links that sheet.", 410);
      return { kind: "sheet", name: s.name, ...data };
    } catch (e) {
      if (e instanceof GoogleError) throw new HubError(e.message, 502);
      throw e;
    }
  }
  const cfg = await getCloud(s.sourceProjectId);
  if (!cfg?.enabled) throw new HubError("The source app's database is off.", 410);
  // Read as the hub: the share itself is the permission, so the table is read in full (read-only).
  const asHub: CloudConfig = { ...cfg, policies: { ...cfg.policies, [s.ref]: { read: "public", write: "owner" } } };
  const q = new URLSearchParams(params);
  q.delete("range");
  const limit = Math.min(Number(q.get("limit")) || 100, MAX_ROWS);
  q.set("limit", String(limit));
  try {
    const rows = await rest(s.sourceProjectId, asHub, "GET", s.ref, q, null, null);
    return { kind: "table", name: s.name, rows };
  } catch (e) {
    if (e instanceof CloudError) throw new HubError(e.message, e.status ?? 400);
    throw e;
  }
}

/** For the Builder: the shares an app can read, with how to call them. */
export async function hubForProject(projectId: string) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!p) return { connected: [], available: [] };
  const [grants, shares] = await Promise.all([
    db.dataGrant.findMany({ where: { projectId, revokedAt: null }, include: { share: true } }),
    db.dataShare.findMany({ where: { workspaceId: p.workspaceId, sourceProjectId: { not: projectId } } }),
  ]);
  return {
    connected: grants.map((g) => ({ name: g.share.name, label: g.share.label, kind: g.share.kind, url: `${origin()}/api/hub/${g.share.name}`, key: g.key })),
    available: shares.filter((s) => !grants.some((g) => g.shareId === s.id)).map((s) => ({ id: s.id, name: s.name, label: s.label, kind: s.kind, description: s.description, openToAll: s.openToAll })),
  };
}
