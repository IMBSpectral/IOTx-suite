import crypto from "node:crypto";
import pg from "pg";

/**
 * PostgreSQL for Cloud projects (engine "postgres"). Every project gets its
 * own database on the Cloud Postgres server (FORGE_CLOUD_PG_URL, else the
 * platform's DATABASE_URL) and its own login role, which owns the project's
 * databases and nothing else. CONNECT is revoked from PUBLIC on each project
 * database, so one project's role can't even connect to another project's
 * database, and Postgres has no cross-database queries. App requests, the SQL
 * editor and migrations all run as the project role; only creating, copying
 * and dropping databases uses the server's admin connection.
 *
 * Names: database fc_<project>, fc_<project>_live, fc_<project>_d_<draft>,
 * backups fc_<project>_b_<id>; role fcr_<project>.
 */

const { Pool } = pg;
type Pool = pg.Pool;
type PoolClient = pg.PoolClient;

export const PG_NAME = /^fcr?_[a-z0-9_]{1,60}$/;

export function pgAdminUrl() {
  const url = process.env.FORGE_CLOUD_PG_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("No Postgres server is configured for Cloud (FORGE_CLOUD_PG_URL or DATABASE_URL).");
  return url;
}

/** The engine new Cloud projects get (FORGE_CLOUD_ENGINE=sqlite|postgres, default sqlite). */
export function defaultEngine(): "sqlite" | "postgres" {
  return process.env.FORGE_CLOUD_ENGINE === "postgres" ? "postgres" : "sqlite";
}

const key = (projectId: string) => {
  const base = projectId.split("@")[0].toLowerCase();
  return /^[0-9a-f-]{36}$/.test(base) ? base.replace(/-/g, "") : crypto.createHash("sha256").update(base).digest("hex").slice(0, 32);
};
const short = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

export const pgRoleName = (projectId: string) => `fcr_${key(projectId)}`;

/** The database behind a data id: "<project>", "<project>@live" or "<project>@<draftId>". */
export function pgDatabaseName(dataId: string) {
  const [base, env] = dataId.split("@");
  if (!env) return `fc_${key(base)}`;
  if (env === "live") return `fc_${key(base)}_live`;
  return `fc_${key(base)}_d_${short(env)}`;
}
export const pgBackupName = (projectId: string, backupId: string) => `fc_${key(projectId)}_b_${short(backupId)}`;

export const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
function checkName(n: string) {
  if (!PG_NAME.test(n)) throw new Error(`Invalid Cloud database name ${n}`);
  return qi(n);
}

// ── Connections ───────────────────────────────────────────────────────────

/** Bigint counts and numeric sums come back as numbers (as from SQLite); timestamps without a zone and dates stay text. */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 20)
      return (v: string) => {
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : v;
      };
    if (oid === 1700) return (v: string) => Number(v);
    if (oid === 1114 || oid === 1082) return (v: string) => v;
    return pg.types.getTypeParser(oid, format ?? "text");
  },
} as unknown as pg.CustomTypesConfig;

type Registry = {
  admin: Pool | null;
  pools: Map<string, Pool>;
  gates: Map<string, Promise<void>>;
  ensured: Map<string, Set<string>>;
};
// One registry per process, whichever bundle loaded this module.
const g = globalThis as unknown as { __forgeCloudPg?: Registry };
const reg: Registry = (g.__forgeCloudPg ??= { admin: null, pools: new Map(), gates: new Map(), ensured: new Map() });

function urlFor(database: string, user?: string, password?: string) {
  const u = new URL(pgAdminUrl());
  if (user) {
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(password ?? "");
  }
  u.pathname = `/${database}`;
  // Prisma-only options confuse node-postgres.
  for (const k of ["schema", "connection_limit", "pool_timeout", "pgbouncer"]) u.searchParams.delete(k);
  return u.toString();
}

export function adminPool() {
  if (!reg.admin) {
    const u = new URL(pgAdminUrl());
    const platformDb = u.pathname.replace(/^\//, "") || "postgres";
    reg.admin = new Pool({ connectionString: urlFor(platformDb), max: 3, idleTimeoutMillis: 10_000, application_name: "iotx-cloud-admin" });
    reg.admin.on("error", (e) => console.error("[cloud-pg] admin", e.message));
  }
  return reg.admin;
}

export type PgTarget = { database: string; user: string; password: string };

/** Wait while the database is being copied, restored or moved. */
export async function pgGate(database: string) {
  for (let i = 0; i < 100; i++) {
    const p = reg.gates.get(database);
    if (!p) return;
    await p;
  }
}

export function pgPool(t: PgTarget) {
  let p = reg.pools.get(t.database);
  if (!p) {
    p = new Pool({
      connectionString: urlFor(t.database, t.user, t.password),
      max: Number(process.env.FORGE_CLOUD_PG_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: Number(process.env.FORGE_CLOUD_PG_STATEMENT_MS ?? 30_000),
      idle_in_transaction_session_timeout: 60_000,
      application_name: "iotx-cloud",
      types,
    });
    p.on("error", (e) => console.error("[cloud-pg]", t.database, e.message));
    reg.pools.set(t.database, p);
  }
  return p;
}

/** DDL already run on this database (CREATE TABLE IF NOT EXISTS for bookkeeping tables), reset with the pool. */
export function ensuredSet(database: string) {
  let s = reg.ensured.get(database);
  if (!s) reg.ensured.set(database, (s = new Set()));
  return s;
}

export async function closePgPool(database: string) {
  const p = reg.pools.get(database);
  reg.pools.delete(database);
  reg.ensured.delete(database);
  if (p) await p.end().catch(() => undefined);
}

/**
 * Run fn with the databases closed to everyone: new queries wait at the gate,
 * this process's pools are closed and other sessions are ended. Needed by
 * CREATE DATABASE … TEMPLATE, renames and drops.
 */
export async function withDatabasesClosed<T>(databases: string[], fn: () => Promise<T>): Promise<T> {
  for (const d of databases) await pgGate(d);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  for (const d of databases) reg.gates.set(d, gate);
  try {
    for (const d of databases) {
      await closePgPool(d);
      await terminate(d);
    }
    return await fn();
  } finally {
    for (const d of databases) if (reg.gates.get(d) === gate) reg.gates.delete(d);
    release();
  }
}

async function terminate(database: string) {
  await adminPool()
    .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database])
    .catch(() => undefined);
}

// ── Roles and databases ───────────────────────────────────────────────────

export async function ensureRole(role: string, password: string) {
  const r = qi(role);
  checkName(role);
  const a = adminPool();
  const exists = (await a.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
  const opts = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40 PASSWORD ${pg.escapeLiteral(password)}`;
  await a.query(exists ? `ALTER ROLE ${r} WITH ${opts}` : `CREATE ROLE ${r} WITH ${opts}`);
}

export async function databaseExists(database: string) {
  return !!(await adminPool().query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount;
}

/** Retry while another session still holds the template (it is ended first, but a straggler can race). */
async function retryInUse<T>(fn: () => Promise<T>, database?: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: string }).code !== "55006" || i >= 6) throw e;
      if (database) await terminate(database);
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
}

/** A new database owned by the project's role, closed to everyone else. */
export async function createDatabase(database: string, owner: string, template?: string) {
  const a = adminPool();
  const sql = `CREATE DATABASE ${checkName(database)} OWNER ${checkName(owner)}${template ? ` TEMPLATE ${checkName(template)}` : " TEMPLATE template0 ENCODING 'UTF8'"}`;
  await retryInUse(() => a.query(sql), template);
  await a.query(`REVOKE ALL ON DATABASE ${qi(database)} FROM PUBLIC`);
  await a.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${qi(database)} TO ${qi(owner)}`);
}

/** An exact copy (schema, data, sequences) of a database: CREATE DATABASE … TEMPLATE, with the source closed for the moment it takes. */
export async function cloneDatabase(source: string, target: string, owner: string) {
  await withDatabasesClosed([source], () => createDatabase(target, owner, source));
}

export async function dropDatabase(database: string) {
  checkName(database);
  await withDatabasesClosed([database], () => adminPool().query(`DROP DATABASE IF EXISTS ${qi(database)} WITH (FORCE)`));
}

export async function renameDatabase(from: string, to: string) {
  await adminPool().query(`ALTER DATABASE ${checkName(from)} RENAME TO ${checkName(to)}`);
}

export async function pgDatabaseSize(database: string) {
  const r = await adminPool()
    .query("SELECT pg_database_size(datname) AS n FROM pg_database WHERE datname = $1", [database])
    .catch(() => null);
  return Number(r?.rows[0]?.n ?? 0);
}

/** Every database the role owns (Test, Live, drafts, backups). */
export async function ownedDatabases(role: string) {
  const r = await adminPool().query(
    "SELECT d.datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = $1",
    [role],
  );
  return r.rows.map((x) => String(x.datname));
}

export async function dropRole(role: string) {
  await adminPool().query(`DROP ROLE IF EXISTS ${checkName(role)}`);
}

export type { PoolClient };
