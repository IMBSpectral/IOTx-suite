import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CloudError,
  closeDatabase,
  cloudDbFile,
  cloudDir,
  cloudEngine,
  getCloud,
  openDatabase,
  pgTarget,
  quoteIdent,
} from "./cloud";
import { isSqlError, withSqlite, type CloudDb } from "./cloud-db";
import { adminPool, createDatabase, databaseExists, dropDatabase, pgBackupName, pgDatabaseSize, qi, withDatabasesClosed } from "./cloud-pg";
import { pgDump } from "./cloud-pg-dump";
import { hashPassword } from "./passwords";

/**
 * The Cloud manager's admin actions (Cloud tab): app users, table rows, a SQL
 * editor, the request log and database backups. Only people who can edit the
 * project reach these (the API checks), never the app's own users.
 *
 * Both engines: SQLite projects keep backups as SQLite files (VACUUM INTO);
 * Postgres projects keep them as databases copied with CREATE DATABASE …
 * TEMPLATE on the same server, and export a SQL dump.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const INTERNAL = /^(_forge_|auth_users$|sqlite_)/;

async function requireCloud(projectId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled)
    throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  return cfg;
}

const isPg = async (projectId: string) => (await cloudEngine(projectId)) === "postgres";

// ── App users ─────────────────────────────────────────────────────────────

export async function searchUsers(projectId: string, q = "") {
  await requireCloud(projectId);
  const like = `%${q.trim().toLowerCase()}%`;
  return openDatabase(projectId).all<{ id: string; email: string; created_at: string }>(
    "SELECT id, email, created_at FROM auth_users WHERE email LIKE ? ORDER BY created_at DESC LIMIT 200",
    [like],
  );
}

const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/** Add a user by hand; without a password one is generated and returned once. */
export async function createUser(
  projectId: string,
  email: string,
  password?: string,
) {
  await requireCloud(projectId);
  const address = email.trim().toLowerCase();
  if (!validEmail(address))
    throw new CloudError("Enter a valid email address.");
  const pw = password || crypto.randomBytes(9).toString("base64url");
  if (pw.length < 8)
    throw new CloudError("Passwords need at least 8 characters.");
  const db = openDatabase(projectId);
  if (await db.get("SELECT 1 FROM auth_users WHERE email = ?", [address]))
    throw new CloudError("A user with this email already exists.", 409);
  const id = crypto.randomUUID();
  await db.run(
    "INSERT INTO auth_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
    [id, address, await hashPassword(pw), new Date().toISOString()],
  );
  return { id, email: address, generatedPassword: password ? null : pw };
}

export async function deleteUser(projectId: string, id: string) {
  await requireCloud(projectId);
  const r = await openDatabase(projectId).run("DELETE FROM auth_users WHERE id = ?", [id]);
  if (!r.changes) throw new CloudError("No such user.", 404);
}

/** Set a user's password; without one, a new one is generated and returned once. */
export async function setUserPassword(
  projectId: string,
  id: string,
  password?: string,
) {
  await requireCloud(projectId);
  const pw = password || crypto.randomBytes(9).toString("base64url");
  if (pw.length < 8)
    throw new CloudError("Passwords need at least 8 characters.");
  const r = await openDatabase(projectId).run("UPDATE auth_users SET password_hash = ? WHERE id = ?", [await hashPassword(pw), id]);
  if (!r.changes) throw new CloudError("No such user.", 404);
  return { generatedPassword: password ? null : pw };
}

// ── Table rows ────────────────────────────────────────────────────────────

async function tableColumns(projectId: string, table: string) {
  if (!IDENT.test(table) || INTERNAL.test(table))
    throw new CloudError("Unknown table", 404);
  const cols = await openDatabase(projectId).columns(table);
  if (!cols.length) throw new CloudError("Unknown table", 404);
  return cols;
}

/** Only real columns, so a key can't smuggle SQL in. */
function cleanRow(cols: { name: string; type: string }[], row: Record<string, unknown>, pg: boolean) {
  const names = new Set(cols.map((c) => c.name));
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!names.has(k)) throw new CloudError(`No column ${k}.`);
    const boolCol = pg && cols.find((c) => c.name === k)?.type === "boolean";
    out[k] =
      v === null || typeof v === "number"
        ? v
        : typeof v === "boolean"
          ? boolCol
            ? v
            : Number(v)
          : String(v);
  }
  return out;
}

/**
 * A number naming a row for the editor: SQLite's rowid, or on Postgres the
 * row's physical address (ctid block × 65536 + item), read fresh with each
 * page of rows.
 */
const PG_ROWID = "((ctid::text::point)[0]::bigint * 65536 + (ctid::text::point)[1]::bigint)";
const PG_BY_ROWID = "ctid = format('(%s,%s)', (?::bigint / 65536), (?::bigint % 65536))::tid";

export async function browseRows(
  projectId: string,
  table: string,
  opts: { limit?: number; offset?: number } = {},
) {
  await requireCloud(projectId);
  await tableColumns(projectId, table);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const db = openDatabase(projectId);
  const t = quoteIdent(table);
  const rows = (await isPg(projectId))
    ? await db.all(`SELECT ${PG_ROWID} AS _rowid, * FROM ${t} ORDER BY ctid DESC LIMIT ? OFFSET ?`, [limit, offset])
    : await db.all(`SELECT rowid AS _rowid, * FROM ${t} ORDER BY rowid DESC LIMIT ? OFFSET ?`, [limit, offset]);
  const total = Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))?.n ?? 0);
  return { rows, total };
}

export async function insertRow(
  projectId: string,
  table: string,
  row: Record<string, unknown>,
) {
  await requireCloud(projectId);
  const pg = await isPg(projectId);
  const cols = await tableColumns(projectId, table);
  const data = cleanRow(cols, row, pg);
  // Tables follow the convention of a text id filled automatically.
  const idCol = cols.find((c) => c.name === "id");
  if (idCol && data.id == null && (!pg || (/^(text|uuid|character varying.*)$/i.test(idCol.type) && idCol.dflt_value === null)))
    data.id = crypto.randomUUID();
  const keys = Object.keys(data);
  if (!keys.length) throw new CloudError("Add at least one value.");
  await openDatabase(projectId).run(
    `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    keys.map((k) => data[k]),
  );
}

export async function updateRow(
  projectId: string,
  table: string,
  rowid: number,
  patch: Record<string, unknown>,
) {
  await requireCloud(projectId);
  const pg = await isPg(projectId);
  const data = cleanRow(await tableColumns(projectId, table), patch, pg);
  const keys = Object.keys(data);
  if (!keys.length) return;
  const r = await openDatabase(projectId).run(
    `UPDATE ${quoteIdent(table)} SET ${keys.map((k) => `${quoteIdent(k)} = ?`).join(", ")} WHERE ${pg ? PG_BY_ROWID : "rowid = ?"}`,
    [...keys.map((k) => data[k]), ...(pg ? [rowid, rowid] : [rowid])],
  );
  if (!r.changes) throw new CloudError("That row no longer exists.", 404);
}

export async function deleteRow(
  projectId: string,
  table: string,
  rowid: number,
) {
  await requireCloud(projectId);
  await tableColumns(projectId, table);
  const pg = await isPg(projectId);
  const r = await openDatabase(projectId).run(
    `DELETE FROM ${quoteIdent(table)} WHERE ${pg ? PG_BY_ROWID : "rowid = ?"}`,
    pg ? [rowid, rowid] : [rowid],
  );
  if (!r.changes) throw new CloudError("That row no longer exists.", 404);
}

// ── SQL editor ────────────────────────────────────────────────────────────

/** Run SQL from the editor: queries return rows (500 at most), other statements run in a transaction. */
export async function runSql(projectId: string, sql: string) {
  await requireCloud(projectId);
  const text = sql.trim();
  if (!text) throw new CloudError("Write a query first.");
  const pg = await isPg(projectId);
  const db = openDatabase(projectId);
  const started = Date.now();
  const query = pg ? /^(SELECT|WITH|EXPLAIN|SHOW|TABLE|VALUES)\b/i : /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i;
  if (query.test(text) && !/;\s*\S/.test(text.replace(/;\s*$/, ""))) {
    let rows: Record<string, unknown>[];
    try {
      rows = (await db.all<Record<string, unknown>>(pg ? text.replace(/;\s*$/, "") : text)).slice(0, 500);
    } catch (e) {
      if (pg && isSqlError(e)) throw new CloudError((e as Error).message);
      throw e;
    }
    return {
      kind: "rows" as const,
      rows: rows.map((r) =>
        "password_hash" in r ? { ...r, password_hash: "[hidden]" } : r,
      ),
      ms: Date.now() - started,
    };
  }
  let changes = 0;
  try {
    changes = await db.transaction((tx) => tx.exec(text));
  } catch (e) {
    throw new CloudError(
      `Nothing was changed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return {
    kind: "done" as const,
    changes,
    ms: Date.now() - started,
  };
}

// ── Request log ───────────────────────────────────────────────────────────

const LOG_KEEP = 2000;
type LogEntry = {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  user_id: string | null;
};

async function logTable(projectId: string) {
  const db = openDatabase(projectId);
  await db.ensure(`CREATE TABLE IF NOT EXISTS _forge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
    status INTEGER NOT NULL, ms INTEGER NOT NULL, user_id TEXT)`);
  return db;
}

/** Record one request to the app's backend (called by the Cloud API route). Never throws. */
export async function logRequest(projectId: string, e: Omit<LogEntry, "at">) {
  try {
    const db = await logTable(projectId);
    await db.run(
      "INSERT INTO _forge_logs (at, method, path, status, ms, user_id) VALUES (?, ?, ?, ?, ?, ?)",
      [new Date().toISOString(), e.method, e.path.slice(0, 300), e.status, e.ms, e.user_id],
    );
    // Keep the newest entries only.
    if (Math.random() < 0.05)
      await db.run(`DELETE FROM _forge_logs WHERE id <= (SELECT max(id) FROM _forge_logs) - ?`, [LOG_KEEP]);
  } catch {
    // Logging must never break the request.
  }
}

export async function readLogs(
  projectId: string,
  opts: { q?: string; errorsOnly?: boolean; since?: string } = {},
) {
  await requireCloud(projectId);
  const where: string[] = [];
  const args: (string | number)[] = [];
  const pg = await isPg(projectId);
  if (opts.q?.trim()) {
    // SQLite's LIKE ignores case; ILIKE on Postgres.
    where.push(pg ? "(path ILIKE ? OR method ILIKE ?)" : "(path LIKE ? OR method LIKE ?)");
    args.push(`%${opts.q.trim()}%`, `%${opts.q.trim()}%`);
  }
  if (opts.errorsOnly) where.push("status >= 400");
  if (opts.since) {
    where.push("at >= ?");
    args.push(opts.since);
  }
  return (await logTable(projectId)).all<LogEntry>(
    `SELECT at, method, path, status, ms, user_id FROM _forge_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 300`,
    args,
  );
}

// ── Backups ───────────────────────────────────────────────────────────────

const backupDir = (projectId: string) =>
  path.join(cloudDir(projectId), "backups");

/** A Postgres backup: a copy of the database on the server, named in a small marker file. */
type PgBackup = { database: string; from: string; at: string; size: number };
const markerFile = (projectId: string, id: string) => path.join(backupDir(projectId), `${id}.pgbackup.json`);

/** A consistent copy of the database (SQLite: VACUUM INTO a file; Postgres: CREATE DATABASE … TEMPLATE), kept beside it. */
export async function createBackup(projectId: string, label = "manual") {
  await requireCloud(projectId);
  await fs.mkdir(backupDir(projectId), { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^a-z0-9-]/gi, "").slice(0, 20) || "manual"}`;
  if (await isPg(projectId)) {
    const t = await pgTarget(projectId);
    const database = pgBackupName(projectId, `${projectId}:${id}`);
    await withDatabasesClosed([t.database], () => createDatabase(database, t.user, t.database));
    const size = await pgDatabaseSize(database);
    const marker: PgBackup = { database, from: projectId, at: new Date().toISOString(), size };
    await fs.writeFile(markerFile(projectId, id), JSON.stringify(marker, null, 2));
    return { id, size };
  }
  const file = path.join(backupDir(projectId), `${id}.sqlite`);
  await withSqlite(cloudDbFile(projectId), (h) => h.prepare("VACUUM INTO ?").run(file));
  const size = (await fs.stat(file)).size;
  return { id, size };
}

export async function listBackups(projectId: string) {
  await requireCloud(projectId);
  const names = await fs
    .readdir(backupDir(projectId))
    .catch(() => [] as string[]);
  const out = [];
  if (await isPg(projectId)) {
    for (const n of names.filter((x) => x.endsWith(".pgbackup.json"))) {
      const m = JSON.parse(await fs.readFile(path.join(backupDir(projectId), n), "utf8")) as PgBackup;
      out.push({ id: n.replace(/\.pgbackup\.json$/, ""), size: m.size, at: m.at });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
  for (const n of names.filter((x) => x.endsWith(".sqlite"))) {
    const st = await fs.stat(path.join(backupDir(projectId), n));
    out.push({
      id: n.replace(/\.sqlite$/, ""),
      size: st.size,
      at: st.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Put a backup back. A safety backup of the current data is taken first. */
export async function restoreBackup(projectId: string, id: string) {
  await requireCloud(projectId);
  if (!/^[\w-]+$/.test(id)) throw new CloudError("Unknown backup", 404);
  if (await isPg(projectId)) {
    const m = JSON.parse(
      await fs.readFile(markerFile(projectId, id), "utf8").catch(() => {
        throw new CloudError("Unknown backup", 404);
      }),
    ) as PgBackup;
    if (!(await databaseExists(m.database))) throw new CloudError("This backup's database is gone.", 404);
    const safety = await createBackup(projectId, "before-restore");
    const t = await pgTarget(projectId);
    const fresh = `${t.database}_r`;
    const old = `${t.database}_o`;
    await withDatabasesClosed([t.database, m.database], async () => {
      const a = adminPool();
      await a.query(`DROP DATABASE IF EXISTS ${qi(fresh)} WITH (FORCE)`);
      await a.query(`DROP DATABASE IF EXISTS ${qi(old)} WITH (FORCE)`);
      // Copy first: if it fails, the current database is untouched.
      await createDatabase(fresh, t.user, m.database);
      await a.query(`ALTER DATABASE ${qi(t.database)} RENAME TO ${qi(old)}`);
      try {
        await a.query(`ALTER DATABASE ${qi(fresh)} RENAME TO ${qi(t.database)}`);
      } catch (e) {
        await a.query(`ALTER DATABASE ${qi(old)} RENAME TO ${qi(t.database)}`);
        throw e;
      }
      await a.query(`DROP DATABASE IF EXISTS ${qi(old)} WITH (FORCE)`);
    });
    return { safetyBackup: safety.id };
  }
  const src = path.join(backupDir(projectId), `${id}.sqlite`);
  await fs.access(src).catch(() => {
    throw new CloudError("Unknown backup", 404);
  });
  const safety = await createBackup(projectId, "before-restore");
  await closeDatabase(projectId);
  const target = cloudDbFile(projectId);
  await fs.copyFile(src, target);
  // The old write-ahead log belongs to the replaced file.
  await fs.rm(`${target}-wal`, { force: true });
  await fs.rm(`${target}-shm`, { force: true });
  await openDatabase(projectId).tables();
  return { safetyBackup: safety.id };
}

export async function deleteBackup(projectId: string, id: string) {
  await requireCloud(projectId);
  if (!/^[\w-]+$/.test(id)) throw new CloudError("Unknown backup", 404);
  if (await isPg(projectId)) {
    const raw = await fs.readFile(markerFile(projectId, id), "utf8").catch(() => null);
    if (raw) await dropDatabase((JSON.parse(raw) as PgBackup).database);
    await fs.rm(markerFile(projectId, id), { force: true });
    return;
  }
  await fs.rm(path.join(backupDir(projectId), `${id}.sqlite`), { force: true });
}

/** What exportDatabase returns for this project: a SQLite file or a PostgreSQL SQL dump. */
export async function exportFormat(projectId: string) {
  return (await isPg(projectId))
    ? { contentType: "application/sql; charset=utf-8", extension: "sql" }
    : { contentType: "application/vnd.sqlite3", extension: "sqlite" };
}

/** The current database as a downloadable file (SQLite file, or a plain SQL dump for Postgres). */
export async function exportDatabase(projectId: string) {
  await requireCloud(projectId);
  if (await isPg(projectId)) {
    const db: CloudDb = openDatabase(projectId);
    return Buffer.from(await db.transaction((tx) => pgDump(tx), { readOnly: true }), "utf8");
  }
  const tmp = path.join(
    backupDir(projectId),
    `.export-${crypto.randomUUID()}.sqlite`,
  );
  await fs.mkdir(backupDir(projectId), { recursive: true });
  await withSqlite(cloudDbFile(projectId), (h) => h.prepare("VACUUM INTO ?").run(tmp));
  try {
    return await fs.readFile(tmp);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
