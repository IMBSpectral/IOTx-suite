import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "./db";
import { audit } from "./workspace-security";
import { can, PermissionError } from "./iotx/permissions";

/**
 * Files: the company's own file storage, on this server's disk (FILES_ROOT,
 * or storage/files beside the app), so it works the same in the cloud and
 * on-premise. Each person has their files and folders; they can share an
 * item with colleagues (view or edit; a shared folder shares everything in
 * it) or as a link that expires. Admins set storage limits: the company's
 * total, a default per person, and per-person overrides. Deleting moves to
 * Trash; emptying Trash frees the space.
 */

export const FILES_ROOT = path.resolve(process.env.FILES_ROOT || path.join(process.cwd(), "storage", "files"));
const GB = BigInt(1024 ** 3);
const DEFAULT_PER_PERSON = BigInt(5) * GB;
const MAX_UPLOAD = BigInt(2) * GB;

type Item = Awaited<ReturnType<typeof db.fileItem.findFirst>> & {};
export type Access = "owner" | "edit" | "view";

async function isAdmin(userId: string, workspaceId: string) {
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } });
  return m?.role === "OWNER" || m?.role === "ADMIN";
}

/** The item and every folder above it, nearest first. */
async function chain(item: NonNullable<Item>) {
  const out = [item];
  let at = item.parentId;
  for (let i = 0; at && i < 30; i++) {
    const p = await db.fileItem.findUnique({ where: { id: at } });
    if (!p) break;
    out.push(p);
    at = p.parentId;
  }
  return out;
}

/** What this person may do with an item: own it, or have it (or a folder above it) shared with them. */
export async function accessTo(userId: string, item: NonNullable<Item>): Promise<Access | null> {
  if (item.ownerId === userId) return "owner";
  const ids = (await chain(item)).map((x) => x.id);
  const shares = await db.fileShare.findMany({ where: { fileId: { in: ids }, kind: "user", userId } });
  if (!shares.length) return null;
  return shares.some((s) => s.canEdit) ? "edit" : "view";
}

async function load(userId: string, workspaceId: string, id: string, need: Access = "view") {
  const item = await db.fileItem.findFirst({ where: { id, workspaceId } });
  if (!item) throw new PermissionError("That file doesn't exist.", 404);
  const a = await accessTo(userId, item);
  const rank = { view: 1, edit: 2, owner: 3 } as const;
  if (!a || rank[a] < rank[need]) throw new PermissionError(need === "view" ? "You don't have access to that." : need === "edit" ? "You can only view this." : "Only its owner can do that.", 403);
  return { item, access: a };
}

const dto = (f: NonNullable<Item>, access: Access, ownerName?: string | null, shared?: number) => ({
  id: f.id,
  kind: f.kind,
  name: f.name,
  size: Number(f.size),
  mime: f.mime,
  parentId: f.parentId,
  ownerId: f.ownerId,
  ownerName: ownerName ?? null,
  updatedAt: f.updatedAt.toISOString(),
  trashedAt: f.trashedAt?.toISOString() ?? null,
  access,
  shared: shared ?? 0,
});

/** A folder's contents (or the top of My files), Shared with me, Trash, or a search. */
export async function listFiles(userId: string, workspaceId: string, q: { view?: string; folder?: string | null; search?: string }) {
  const view = q.view ?? "mine";
  let rows: NonNullable<Item>[] = [];
  let crumbs: { id: string; name: string }[] = [];
  let access: Access = "owner";
  if (q.search?.trim()) {
    const term = q.search.trim().slice(0, 100);
    const sharedIds = (await db.fileShare.findMany({ where: { kind: "user", userId }, select: { fileId: true } })).map((s) => s.fileId);
    rows = await db.fileItem.findMany({
      where: { workspaceId, trashedAt: null, name: { contains: term, mode: "insensitive" }, OR: [{ ownerId: userId }, { id: { in: sharedIds } }] },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  } else if (view === "trash") {
    const all = await db.fileItem.findMany({ where: { workspaceId, ownerId: userId, trashedAt: { not: null } }, orderBy: { trashedAt: "desc" }, take: 2000 });
    // Only what was deleted itself: things inside a deleted folder come back with it.
    const gone = new Set(all.map((r) => r.id));
    rows = all.filter((r) => !r.parentId || !gone.has(r.parentId)).slice(0, 500);
  } else if (view === "shared" && !q.folder) {
    const shares = await db.fileShare.findMany({ where: { kind: "user", userId }, include: { file: true } });
    rows = shares.map((s) => s.file).filter((f) => f.workspaceId === workspaceId && !f.trashedAt);
    access = "view";
  } else if (q.folder) {
    const { item, access: a } = await load(userId, workspaceId, q.folder);
    if (item.kind !== "folder") throw new PermissionError("That isn't a folder.");
    access = a;
    rows = await db.fileItem.findMany({ where: { workspaceId, parentId: item.id, trashedAt: null }, orderBy: [{ kind: "desc" }, { name: "asc" }] });
    // Breadcrumbs up to the top, or to the shared folder this person was given.
    for (const c of await chain(item)) {
      crumbs.unshift({ id: c.id, name: c.name });
      if (c.ownerId !== userId && (await db.fileShare.findFirst({ where: { fileId: c.id, kind: "user", userId } }))) break;
    }
  } else {
    rows = await db.fileItem.findMany({ where: { workspaceId, ownerId: userId, parentId: null, trashedAt: null }, orderBy: [{ kind: "desc" }, { name: "asc" }] });
  }
  const owners = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } }, select: { id: true, name: true, email: true } });
  const who = new Map(owners.map((o) => [o.id, o.name || o.email]));
  const counts = await db.fileShare.groupBy({ by: ["fileId"], where: { fileId: { in: rows.map((r) => r.id) } }, _count: true });
  const shared = new Map(counts.map((c) => [c.fileId, c._count]));
  const items = await Promise.all(rows.map(async (r) => dto(r, r.ownerId === userId ? "owner" : view === "shared" || q.search ? ((await accessTo(userId, r)) ?? "view") : access, who.get(r.ownerId), shared.get(r.id))));
  crumbs = crumbs.length ? crumbs : [];
  return { view, folder: q.folder ?? null, access, crumbs, items };
}

// ── Space ────────────────────────────────────────────────────────────────────

async function usedBy(workspaceId: string, userId?: string) {
  const r = await db.fileItem.aggregate({ where: { workspaceId, kind: "file", ...(userId ? { ownerId: userId } : {}) }, _sum: { size: true } });
  return r._sum.size ?? BigInt(0);
}

/** Limits that apply: the person's own, else the default per person; and the company's total (null = none). */
export async function limitsFor(workspaceId: string, userId: string) {
  const rows = await db.storageQuota.findMany({ where: { workspaceId, OR: [{ userId }, { userId: "*" }, { userId: null }] } });
  const mine = rows.find((r) => r.userId === userId)?.limitBytes ?? rows.find((r) => r.userId === "*")?.limitBytes ?? DEFAULT_PER_PERSON;
  const company = rows.find((r) => r.userId === null)?.limitBytes ?? null;
  return { mine, company };
}

export async function usage(userId: string, workspaceId: string) {
  const [mine, all, limits] = await Promise.all([usedBy(workspaceId, userId), usedBy(workspaceId), limitsFor(workspaceId, userId)]);
  return { used: Number(mine), limit: Number(limits.mine), companyUsed: Number(all), companyLimit: limits.company === null ? null : Number(limits.company) };
}

async function ensureRoom(workspaceId: string, userId: string, bytes: bigint) {
  const [mine, all, limits] = await Promise.all([usedBy(workspaceId, userId), usedBy(workspaceId), limitsFor(workspaceId, userId)]);
  const gb = (n: bigint) => `${(Number(n) / 1024 ** 3).toFixed(1)} GB`;
  if (mine + bytes > limits.mine) throw new PermissionError(`Not enough space: you're using ${gb(mine)} of your ${gb(limits.mine)}. Empty Trash or ask an admin for more.`, 413);
  if (limits.company !== null && all + bytes > limits.company) throw new PermissionError(`The company's storage (${gb(limits.company)}) is full. Ask an admin.`, 413);
}

// ── Changes ──────────────────────────────────────────────────────────────────

const cleanName = (s: unknown) => {
  const n = String(s ?? "").replace(/[\\/\u0000-\u001f]/g, " ").trim().slice(0, 200);
  if (!n || n === "." || n === "..") throw new PermissionError("Give it a name.");
  return n;
};

/** Where new items go: a folder this person can edit, or the top of their files. */
async function target(userId: string, workspaceId: string, parentId?: string | null) {
  if (!parentId) return { parentId: null, ownerId: userId };
  const { item } = await load(userId, workspaceId, parentId, "edit");
  if (item.kind !== "folder") throw new PermissionError("That isn't a folder.");
  // Things added to someone else's shared folder belong to that folder's owner.
  return { parentId: item.id, ownerId: item.ownerId };
}

export async function createFolder(userId: string, workspaceId: string, name: unknown, parentId?: string | null) {
  const t = await target(userId, workspaceId, parentId);
  const f = await db.fileItem.create({ data: { workspaceId, ownerId: t.ownerId, parentId: t.parentId, kind: "folder", name: cleanName(name) } });
  return dto(f, "owner");
}

/** Save an uploaded file's bytes to disk, within the space limits. */
export async function uploadFile(userId: string, workspaceId: string, file: File, parentId?: string | null) {
  if (!(await can(userId, workspaceId, "files.upload"))) throw new PermissionError("Your role can't upload files. Ask an admin.", 403);
  const size = BigInt(file.size);
  if (size > MAX_UPLOAD) throw new PermissionError("Files can be up to 2 GB.", 413);
  const t = await target(userId, workspaceId, parentId);
  await ensureRoom(workspaceId, t.ownerId, size);
  const key = `${workspaceId}/${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(16).toString("hex")}`;
  const dest = path.join(FILES_ROOT, key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(file.stream() as never), fs.createWriteStream(dest));
  const f = await db.fileItem.create({
    data: { workspaceId, ownerId: t.ownerId, parentId: t.parentId, kind: "file", name: cleanName(file.name || "file"), size, mime: file.type || "application/octet-stream", storageKey: key },
  });
  return dto(f, "owner");
}

export async function renameItem(userId: string, workspaceId: string, id: string, name: unknown) {
  const { item } = await load(userId, workspaceId, id, "edit");
  return db.fileItem.update({ where: { id: item.id }, data: { name: cleanName(name) } });
}

export async function moveItem(userId: string, workspaceId: string, id: string, parentId: string | null) {
  const { item } = await load(userId, workspaceId, id, "owner");
  if (parentId) {
    const { item: p } = await load(userId, workspaceId, parentId, "edit");
    if (p.kind !== "folder") throw new PermissionError("That isn't a folder.");
    if ((await chain(p)).some((x) => x.id === item.id)) throw new PermissionError("A folder can't go inside itself.");
  }
  return db.fileItem.update({ where: { id: item.id }, data: { parentId } });
}

/** Everything inside a folder (for trash, restore and delete). */
async function descendants(workspaceId: string, id: string) {
  const out: string[] = [];
  let level = [id];
  for (let i = 0; level.length && i < 50; i++) {
    const kids = await db.fileItem.findMany({ where: { workspaceId, parentId: { in: level } }, select: { id: true } });
    level = kids.map((k) => k.id);
    out.push(...level);
  }
  return out;
}

export async function trashItem(userId: string, workspaceId: string, id: string) {
  const { item } = await load(userId, workspaceId, id, "edit");
  const ids = [item.id, ...(await descendants(workspaceId, item.id))];
  await db.fileItem.updateMany({ where: { id: { in: ids } }, data: { trashedAt: new Date() } });
}

export async function restoreItem(userId: string, workspaceId: string, id: string) {
  const { item } = await load(userId, workspaceId, id, "owner");
  const ids = [item.id, ...(await descendants(workspaceId, item.id))];
  // Back where it was, or to the top if that folder is gone or in Trash.
  const parent = item.parentId ? await db.fileItem.findUnique({ where: { id: item.parentId } }) : null;
  await db.fileItem.updateMany({ where: { id: { in: ids } }, data: { trashedAt: null } });
  if (item.parentId && (!parent || parent.trashedAt)) await db.fileItem.update({ where: { id: item.id }, data: { parentId: null } });
}

/** Delete for good (from Trash): removes the bytes and frees the space. */
export async function deleteForever(userId: string, workspaceId: string, id: string) {
  if (!(await can(userId, workspaceId, "files.delete"))) throw new PermissionError("Your role can't delete files for good. Ask an admin.", 403);
  const { item } = await load(userId, workspaceId, id, "owner");
  const ids = [item.id, ...(await descendants(workspaceId, item.id))];
  const files = await db.fileItem.findMany({ where: { id: { in: ids }, kind: "file" }, select: { storageKey: true } });
  await db.fileItem.deleteMany({ where: { id: { in: ids } } });
  for (const f of files) if (f.storageKey) await fsp.rm(path.join(FILES_ROOT, f.storageKey), { force: true }).catch(() => undefined);
}

export async function emptyTrash(userId: string, workspaceId: string) {
  const top = await db.fileItem.findMany({ where: { workspaceId, ownerId: userId, trashedAt: { not: null } }, select: { id: true } });
  for (const t of top) await deleteForever(userId, workspaceId, t.id).catch(() => undefined);
  return top.length;
}

// ── Sharing ──────────────────────────────────────────────────────────────────

export async function sharesOf(userId: string, workspaceId: string, id: string) {
  const { item } = await load(userId, workspaceId, id, "owner");
  const rows = await db.fileShare.findMany({ where: { fileId: item.id }, orderBy: { createdAt: "asc" } });
  const people = await db.user.findMany({ where: { id: { in: rows.map((r) => r.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true, email: true } });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    userId: r.userId,
    name: people.find((p) => p.id === r.userId)?.name ?? people.find((p) => p.id === r.userId)?.email ?? null,
    canEdit: r.canEdit,
    token: r.token,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }));
}

export async function shareWith(userId: string, workspaceId: string, id: string, b: { userId?: unknown; canEdit?: unknown }) {
  const { item } = await load(userId, workspaceId, id, "owner");
  const to = String(b.userId ?? "");
  if (to === userId) throw new PermissionError("It's already yours.");
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: to, workspaceId } } });
  if (!m) throw new PermissionError("That person isn't in this workspace.", 404);
  const existing = await db.fileShare.findFirst({ where: { fileId: item.id, kind: "user", userId: to } });
  const s = existing
    ? await db.fileShare.update({ where: { id: existing.id }, data: { canEdit: b.canEdit === true } })
    : await db.fileShare.create({ data: { fileId: item.id, kind: "user", userId: to, canEdit: b.canEdit === true, createdBy: userId } });
  const me = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  if (!existing) await db.notification.create({ data: { userId: to, kind: "files", title: `${me?.name || me?.email} shared "${item.name}" with you`, href: "/files?view=shared" } }).catch(() => undefined);
  return s;
}

/** A link anyone can open (no sign-in) until it expires. Needs "Share links outside the company". */
export async function shareLink(userId: string, workspaceId: string, id: string, days: number) {
  if (!(await can(userId, workspaceId, "files.share.external"))) throw new PermissionError("Your role can't make links for outside the company. Ask an admin.", 403);
  const { item } = await load(userId, workspaceId, id, "owner");
  if (item.kind !== "file") throw new PermissionError("Links work for files, not folders.");
  const d = Math.min(Math.max(Math.round(days) || 7, 1), 90);
  const s = await db.fileShare.create({ data: { fileId: item.id, kind: "link", token: crypto.randomBytes(18).toString("base64url"), expiresAt: new Date(Date.now() + d * 86_400_000), createdBy: userId } });
  await audit(workspaceId, userId, "people.changed", `Made a ${d}-day link to the file "${item.name}"`);
  return s;
}

export async function unshare(userId: string, workspaceId: string, shareId: string) {
  const s = await db.fileShare.findUnique({ where: { id: shareId }, include: { file: true } });
  if (!s || s.file.workspaceId !== workspaceId) throw new PermissionError("Not found.", 404);
  if (s.file.ownerId !== userId && s.userId !== userId) throw new PermissionError("Only the owner can change sharing.", 403);
  await db.fileShare.delete({ where: { id: shareId } });
}

// ── Reading bytes ────────────────────────────────────────────────────────────

function stream(item: NonNullable<Item>, inline: boolean) {
  const file = path.join(FILES_ROOT, item.storageKey ?? "");
  if (!item.storageKey || !file.startsWith(FILES_ROOT) || !fs.existsSync(file)) return new Response("The file's contents are missing.", { status: 410 });
  // Only types a browser can show safely are opened inline; everything else downloads.
  const safe = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav)|text\/plain)$/.test(item.mime ?? "");
  const disp = `${inline && safe ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`;
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      "content-type": inline && safe ? item.mime! : "application/octet-stream",
      "content-length": String(item.size),
      "content-disposition": disp,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
      "cache-control": "private, max-age=60",
    },
  });
}

export async function download(userId: string, workspaceId: string, id: string, inline: boolean) {
  const { item } = await load(userId, workspaceId, id, "view");
  if (item.kind !== "file") throw new PermissionError("Folders can't be downloaded yet; open it and download the files.");
  return stream(item, inline);
}

export async function downloadByLink(token: string) {
  const s = await db.fileShare.findUnique({ where: { token }, include: { file: true } });
  if (!s || s.kind !== "link" || (s.expiresAt && s.expiresAt < new Date()) || s.file.trashedAt) return new Response("This link has expired or was removed.", { status: 404 });
  return stream(s.file, true);
}

// ── Admin: storage limits ────────────────────────────────────────────────────

export async function storageAdmin(actorId: string, workspaceId: string) {
  if (!(await isAdmin(actorId, workspaceId))) throw new PermissionError("Only owners and admins manage storage.", 403);
  const [quotas, members, perOwner] = await Promise.all([
    db.storageQuota.findMany({ where: { workspaceId } }),
    db.membership.findMany({ where: { workspaceId }, include: { user: { select: { id: true, name: true, email: true } } } }),
    db.fileItem.groupBy({ by: ["ownerId"], where: { workspaceId, kind: "file" }, _sum: { size: true }, _count: true }),
  ]);
  const def = quotas.find((q) => q.userId === "*")?.limitBytes ?? DEFAULT_PER_PERSON;
  const company = quotas.find((q) => q.userId === null)?.limitBytes ?? null;
  return {
    company: company === null ? null : Number(company),
    perPerson: Number(def),
    used: Number(perOwner.reduce((n, o) => n + (o._sum.size ?? BigInt(0)), BigInt(0))),
    disk: await diskFree(),
    people: members.map((m) => {
      const own = quotas.find((q) => q.userId === m.userId);
      const u = perOwner.find((o) => o.ownerId === m.userId);
      return { userId: m.userId, name: m.user.name || m.user.email, email: m.user.email, used: Number(u?._sum.size ?? 0), files: u?._count ?? 0, limit: Number(own?.limitBytes ?? def), custom: !!own };
    }),
  };
}

/** Free space on the disk that holds the files (so admins don't promise more than the server has). */
async function diskFree() {
  try {
    await fsp.mkdir(FILES_ROOT, { recursive: true });
    const s = await fsp.statfs(FILES_ROOT);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** Set a limit in GB: who = "company", "default" or a person's id; null removes a person's override or the company cap. */
export async function setLimit(actorId: string, workspaceId: string, who: string, gb: number | null) {
  if (!(await isAdmin(actorId, workspaceId))) throw new PermissionError("Only owners and admins manage storage.", 403);
  const userId = who === "company" ? null : who === "default" ? "*" : who;
  if (userId && userId !== "*" && !(await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } }))) throw new PermissionError("That person isn't in this workspace.", 404);
  const existing = await db.storageQuota.findFirst({ where: { workspaceId, userId } });
  if (gb === null) {
    if (existing) await db.storageQuota.delete({ where: { id: existing.id } });
  } else {
    if (!(gb > 0 && gb <= 100_000)) throw new PermissionError("Give a size between 0.1 and 100,000 GB.");
    const limitBytes = BigInt(Math.round(gb * 1024 ** 3));
    if (existing) await db.storageQuota.update({ where: { id: existing.id }, data: { limitBytes } });
    else await db.storageQuota.create({ data: { workspaceId, userId, limitBytes } });
  }
  await audit(workspaceId, actorId, "people.changed", `Set ${who === "company" ? "the company's" : who === "default" ? "the default per-person" : "a person's"} storage limit to ${gb === null ? "none" : `${gb} GB`}`);
}
