import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import { type Access, type CloudConfig, CloudError, cloudDir, getCloud, openDatabase, updateCloud, cloudUrl } from "./cloud";

/**
 * Forge Cloud storage: file buckets for the user's app (avatars, uploads,
 * attachments), in the style of Supabase Storage. Files live on disk under
 * the project's Cloud folder; their metadata (size, type, uploader) sits in
 * the project database's _forge_storage table.
 *
 * Bucket access: "public" (anyone can read, so <img src> works), "authenticated"
 * (any signed-in app user) or "owner" (only the uploader). Writes always need a
 * signed-in user; private files can be shared with an expiring signed URL.
 */

export type Bucket = { access: Access; createdAt: string };
export type StoredFile = { bucket: string; path: string; size: number; content_type: string; owner_id: string | null; created_at: string; updated_at: string };

export const MAX_FILE_BYTES = Number(process.env.FORGE_STORAGE_MAX_FILE ?? 25 * 1024 * 1024);
export const MAX_PROJECT_BYTES = Number(process.env.FORGE_STORAGE_MAX_TOTAL ?? 1024 * 1024 * 1024);
const MAX_BUCKETS = 20;
const BUCKET_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SEGMENT = /^[\w.\- ()@+]{1,200}$/;

/** Every Cloud backend starts with these two. */
export const DEFAULT_BUCKETS: Record<string, Bucket> = {
  public: { access: "public", createdAt: "" },
  uploads: { access: "owner", createdAt: "" },
};

const storageRoot = (projectId: string) => path.join(cloudDir(projectId), "storage");

export function buckets(cfg: CloudConfig): Record<string, Bucket> {
  return cfg.storage?.buckets ?? DEFAULT_BUCKETS;
}

/** A clean object path ("avatars/ana.png"); rejects "..", absolute paths and odd characters. */
export function cleanPath(raw: string) {
  const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.length > 10 || parts.some((p) => p === "." || p === ".." || !SEGMENT.test(p))) {
    throw new CloudError("Use a file path like folder/name.png (letters, numbers, - _ . only).");
  }
  return parts.join("/");
}

function bucketOf(cfg: CloudConfig, name: string) {
  const b = buckets(cfg)[name];
  if (!b) throw new CloudError(`There is no storage bucket called ${name}.`, 404);
  return b;
}

async function table(projectId: string) {
  const db = openDatabase(projectId);
  await db.ensure(`CREATE TABLE IF NOT EXISTS _forge_storage (
    bucket TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL,
    owner_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (bucket, path))`);
  return db;
}

const fileOnDisk = (projectId: string, bucket: string, p: string) => path.join(storageRoot(projectId), bucket, ...p.split("/"));

async function meta(projectId: string, bucket: string, p: string) {
  return (await table(projectId)).get<StoredFile>("SELECT * FROM _forge_storage WHERE bucket = ? AND path = ?", [bucket, p]);
}

export async function storageUsed(projectId: string) {
  const r = await (await table(projectId)).get<{ n: number; c: number }>("SELECT COALESCE(SUM(size), 0) AS n, COUNT(*) AS c FROM _forge_storage");
  return { bytes: Number(r?.n ?? 0), files: Number(r?.c ?? 0) };
}

function canRead(b: Bucket, f: StoredFile, user: { id: string } | null) {
  if (b.access === "public") return true;
  if (!user) return false;
  return b.access === "authenticated" || f.owner_id === user.id;
}

// ── Writing ───────────────────────────────────────────────────────────────

/**
 * Store a file. `user` is the app user (null for the Cloud manager, which may
 * write anywhere). Overwriting someone else's file is refused unless the bucket
 * is shared by every signed-in user.
 */
export async function putFile(
  projectId: string,
  cfg: CloudConfig,
  bucket: string,
  rawPath: string,
  bytes: Uint8Array,
  contentType: string,
  user: { id: string } | null,
  { admin = false } = {},
) {
  const b = bucketOf(cfg, bucket);
  const p = cleanPath(rawPath);
  if (!admin && !user) throw new CloudError("Sign in to upload files.", 401);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new CloudError(`Files can be at most ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`, 413);
  const existing = await meta(projectId, bucket, p);
  if (existing && !admin && existing.owner_id !== user?.id && b.access !== "authenticated") {
    throw new CloudError("A file with this name belongs to someone else.", 403);
  }
  const used = (await storageUsed(projectId)).bytes - Number(existing?.size ?? 0);
  if (used + bytes.byteLength > MAX_PROJECT_BYTES) throw new CloudError("This app's storage is full. Delete some files first.", 507);

  const file = fileOnDisk(projectId, bucket, p);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  const now = new Date().toISOString();
  const type = (contentType || "application/octet-stream").split(";")[0].trim().slice(0, 100);
  await (await table(projectId)).run(
    `INSERT INTO _forge_storage (bucket, path, size, content_type, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bucket, path) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = excluded.updated_at`,
    [bucket, p, bytes.byteLength, type, existing?.owner_id ?? user?.id ?? null, existing?.created_at ?? now, now],
  );
  return { bucket, path: p, size: bytes.byteLength, contentType: type, url: fileUrl(projectId, cfg, bucket, p) };
}

export async function removeFile(projectId: string, cfg: CloudConfig, bucket: string, rawPath: string, user: { id: string } | null, { admin = false } = {}) {
  bucketOf(cfg, bucket);
  const p = cleanPath(rawPath);
  const f = await meta(projectId, bucket, p);
  if (!f) throw new CloudError("File not found", 404);
  if (!admin && (!user || f.owner_id !== user.id)) throw new CloudError("Only the person who uploaded a file can delete it.", 403);
  await fs.rm(fileOnDisk(projectId, bucket, p), { force: true });
  await (await table(projectId)).run("DELETE FROM _forge_storage WHERE bucket = ? AND path = ?", [bucket, p]);
  return { deleted: 1 };
}

// ── Reading ───────────────────────────────────────────────────────────────

export async function readFile(projectId: string, cfg: CloudConfig, bucket: string, rawPath: string, user: { id: string } | null, { admin = false, signed = false } = {}) {
  const b = bucketOf(cfg, bucket);
  const p = cleanPath(rawPath);
  const f = await meta(projectId, bucket, p);
  if (!f || !(admin || signed || canRead(b, f, user))) throw new CloudError("File not found", 404);
  const bytes = await fs.readFile(fileOnDisk(projectId, bucket, p)).catch(() => null);
  if (!bytes) throw new CloudError("File not found", 404);
  return { file: f, bytes };
}

/** Files in a bucket the user may see, newest first. */
export async function listFiles(projectId: string, cfg: CloudConfig, bucket: string, user: { id: string } | null, { prefix = "", admin = false, limit = 100, offset = 0 } = {}) {
  const b = bucketOf(cfg, bucket);
  if (!admin && b.access !== "public" && !user) throw new CloudError("Sign in to see these files.", 401);
  const where = ["bucket = ?"];
  const args: (string | number)[] = [bucket];
  if (prefix) {
    where.push("path LIKE ? ESCAPE '\\'");
    args.push(prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%");
  }
  if (!admin && b.access === "owner") {
    where.push("owner_id = ?");
    args.push(user!.id);
  }
  const rows = await (await table(projectId)).all<StoredFile>(
    `SELECT * FROM _forge_storage WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...args, Math.min(1000, Math.max(1, limit)), Math.max(0, offset)],
  );
  return rows.map((f) => ({ ...f, url: fileUrl(projectId, cfg, bucket, f.path) }));
}

// ── URLs ──────────────────────────────────────────────────────────────────

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Public buckets get a plain URL; private files are fetched through the API (or a signed URL). */
export function fileUrl(projectId: string, cfg: CloudConfig, bucket: string, p: string) {
  return buckets(cfg)[bucket]?.access === "public" ? `${cloudUrl(projectId)}/storage/public/${bucket}/${encodePath(p)}` : null;
}

function signature(cfg: CloudConfig, bucket: string, p: string, exp: number) {
  return crypto.createHmac("sha256", cfg.jwtSecret).update(`storage:${bucket}/${p}:${exp}`).digest("base64url");
}

/** A link anyone can open until it expires (default one hour, at most a week). */
export async function signedUrl(projectId: string, cfg: CloudConfig, bucket: string, rawPath: string, user: { id: string } | null, expiresIn = 3600, { admin = false } = {}) {
  await readFile(projectId, cfg, bucket, rawPath, user, { admin }); // same rule as reading
  const p = cleanPath(rawPath);
  const exp = Math.floor(Date.now() / 1000) + Math.min(7 * 86400, Math.max(60, Math.floor(expiresIn) || 3600));
  return { url: `${cloudUrl(projectId)}/storage/signed/${bucket}/${encodePath(p)}?exp=${exp}&sig=${signature(cfg, bucket, p, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function checkSignature(cfg: CloudConfig, bucket: string, rawPath: string, exp: string | null, sig: string | null) {
  const p = cleanPath(rawPath);
  const e = Number(exp);
  if (!sig || !Number.isFinite(e) || e < Date.now() / 1000) return false;
  const want = Buffer.from(signature(cfg, bucket, p, e));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── Buckets (Cloud manager and agent) ─────────────────────────────────────

export async function createBucket(projectId: string, name: string, access: Access) {
  if (!BUCKET_NAME.test(name)) throw new CloudError("Bucket names use lowercase letters, numbers, - and _.");
  if (!["public", "authenticated", "owner"].includes(access)) throw new CloudError("Access is public, authenticated or owner.");
  const cfg = await updateCloud(projectId, (c) => {
    const s = (c.storage ??= { buckets: { ...DEFAULT_BUCKETS } });
    if (Object.keys(s.buckets).length >= MAX_BUCKETS && !s.buckets[name]) throw new CloudError(`At most ${MAX_BUCKETS} buckets.`);
    s.buckets[name] = { access, createdAt: s.buckets[name]?.createdAt || new Date().toISOString() };
  });
  return buckets(cfg);
}

/** Delete a bucket and every file in it. */
export async function deleteBucket(projectId: string, name: string) {
  const cfg = await getCloud(projectId);
  if (!cfg) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  bucketOf(cfg, name);
  await updateCloud(projectId, (c) => {
    const s = (c.storage ??= { buckets: { ...DEFAULT_BUCKETS } });
    delete s.buckets[name];
  });
  await (await table(projectId)).run("DELETE FROM _forge_storage WHERE bucket = ?", [name]);
  await fs.rm(path.join(storageRoot(projectId), name), { recursive: true, force: true });
}

/** Buckets with their file counts and sizes, for the Cloud tab. */
export async function bucketSummary(projectId: string, cfg: CloudConfig) {
  const counts = await (await table(projectId)).all<{ bucket: string; files: number; bytes: number }>(
    "SELECT bucket, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM _forge_storage GROUP BY bucket",
  );
  return Object.entries(buckets(cfg)).map(([name, b]) => {
    const c = counts.find((x) => x.bucket === name);
    return { name, access: b.access, files: Number(c?.files ?? 0), bytes: Number(c?.bytes ?? 0) };
  });
}
