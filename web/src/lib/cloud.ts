import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { PROJECTS_ROOT } from "./paths";
import { hashPassword, verifyPassword } from "./passwords";
import { open as openBox, seal, type SecretBox as SealedBox } from "./secret-box";
import { readWorkspaceSecret, workspaceSecretNames } from "./workspace-secrets";
import { closeSqlite, EngineMovedError, isSqlError, PgDb, SqliteDb, type CloudDb, type ColumnInfo, type Engine, type Param, type Row } from "./cloud-db";
import {
  closePgPool,
  createDatabase,
  databaseExists,
  defaultEngine,
  dropDatabase,
  dropRole,
  ensureRole,
  ownedDatabases,
  pgDatabaseName,
  pgDatabaseSize,
  pgRoleName,
  type PgTarget,
} from "./cloud-pg";

export type { CloudDb, Engine } from "./cloud-db";

// Same derivation as before the helper moved, so stored secrets still decrypt.
const SECRETS_PURPOSE = "forge-cloud-secrets";
const PG_PURPOSE = "forge-cloud-pg";

/**
 * Forge Cloud: a backend for the user's app, the local counterpart of
 * Lovable Cloud. Each project gets its own database, app auth
 * (email + password, JWT), access rules per table, encrypted secrets, and a
 * REST surface at /cloud/v1/<projectId>. Agent-written SQL only ever touches
 * that project's database, never Forge's own.
 *
 * The database engine is per project (config.engine): a SQLite file (the
 * default, and every project made before PostgreSQL support) or a PostgreSQL
 * database of its own with its own login role (see cloud-pg.ts). All access
 * goes through the CloudDb interface (cloud-db.ts).
 *
 * Schema changes go through migrations the user approves.
 */

export type Access = "public" | "authenticated" | "owner";
export type Policy = { read: Access; write: Access };
type SecretBox = { iv: string; data: string; tag: string; updatedAt: string };
export type CloudConfig = {
  enabled: boolean;
  enabledAt: string | null;
  anonKey: string;
  jwtSecret: string;
  policies: Record<string, Policy>;
  secrets: Record<string, SecretBox>;
  requestedSecrets: { name: string; description: string }[];
  /** Set while the backend is paused; the app gets 503s until it is woken. See cloud-ops.ts. */
  paused?: { reason: PauseReason; at: string } | null;
  /** Last time the app used its backend (throttled), for auto-pause after inactivity. */
  lastActiveAt?: string;
  /** Last pause or wake, for the cooldown between them. */
  toggledAt?: string;
  /** AI for the app (on by default with Cloud) and the email outbox. */
  ai?: { enabled: boolean; logBodies?: boolean; creditLimit?: number };
  /** mailboxId: a company shared mailbox the app sends from (Settings → Mailboxes). */
  email?: { enabled: boolean; fromName: string; mailboxId?: string | null };
  /** The app's MCP server: on with a token (stored hashed), so AI clients can read and add data. */
  mcp?: { enabled: boolean; tokenHash: string; createdAt: string } | null;
  /** How the app's users sign in (see cloud-auth.ts); absent means email + password, open sign-up. */
  auth?: { password: boolean; emailCode: boolean; forge?: boolean; google?: boolean; signups: boolean; allowedDomains: string[] };
  /** File storage buckets (see cloud-storage.ts); absent means the defaults. */
  storage?: { buckets: Record<string, { access: Access; createdAt: string }> };
  /** Database engine; absent means SQLite (every project made before PostgreSQL support). */
  engine?: Engine;
  /** The project's own Postgres login role (password sealed), when engine is postgres. */
  pg?: { role: string; password: SealedBox } | null;
  /** When and how the project moved from SQLite to Postgres. */
  movedToPostgres?: { at: string; sqliteBackups: string[] } | null;
};

export type PauseReason = "inactivity" | "manual" | "out_of_credits" | "credit_limit" | "excessive_usage";

export const CLOUD_ORIGIN = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";
export const cloudUrl = (projectId: string) => `${CLOUD_ORIGIN}/cloud/v1/${projectId}`;
const DEFAULT_POLICY: Policy = { read: "public", write: "authenticated" };
const INTERNAL = /^(_forge_|auth_users$|sqlite_)/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

// A data id is a project id, or "<projectId>@<draftId>" for a draft's own
// database: same config (keys, policies, secrets), separate data.
const baseId = (id: string) => id.split("@")[0];
const dir = (projectId: string) => path.join(PROJECTS_ROOT, "_cloud", baseId(projectId));
const configFile = (projectId: string) => path.join(dir(projectId), "config.json");
const dbFile = (id: string) => {
  const draft = id.split("@")[1];
  return draft ? path.join(dir(id), "drafts", `${draft.replace(/[^\w-]/g, "")}.sqlite`) : path.join(dir(id), "data.sqlite");
};
export const draftDataId = (projectId: string, draftId: string) => `${projectId}@${draftId}`;
export const draftDatabaseExists = (projectId: string, draftId: string) => dataExists(draftDataId(projectId, draftId));

/** Whether the database behind a data id exists (SQLite file or Postgres database). */
export async function dataExists(dataId: string) {
  if ((await cloudEngine(dataId)) === "postgres") return databaseExists(pgDatabaseName(dataId)).catch(() => false);
  return fs.stat(dbFile(dataId)).then(
    () => true,
    () => false,
  );
}

/** Drop a draft's own database (draft accepted, discarded, or its backend turned off). */
export async function removeDraftDatabase(projectId: string, draftId: string) {
  const id = draftDataId(projectId, draftId);
  if ((await cloudEngine(id)) === "postgres") {
    await dropDatabase(pgDatabaseName(id));
    return;
  }
  closeSqlite(dbFile(id));
  for (const ext of ["", "-wal", "-shm"]) await fs.rm(dbFile(id) + ext, { force: true, maxRetries: 8, retryDelay: 250 });
}

export class CloudError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export async function getCloud(projectId: string): Promise<CloudConfig | null> {
  const raw = await fs.readFile(configFile(projectId), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudConfig;
  } catch {
    // An older, non-atomic save could leave a stray tail after the JSON ("Unexpected
    // non-whitespace character after JSON"). Keep the first complete object and repair the file.
    const cfg = firstJsonObject(raw) as CloudConfig | null;
    if (!cfg) throw new CloudError(`This app's ${getBrand().shortName} Cloud settings file is damaged. Contact support.`, 500);
    await saveCloud(projectId, cfg).catch(() => undefined);
    return cfg;
  }
}

/** The first complete top-level JSON object in a string, or null. */
function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(raw.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// One write at a time per project file, across every copy of this module, and each write
// atomic (a temp file renamed over the old one), so two saves can't interleave into bad JSON.
const gw = globalThis as unknown as { __forgeCloudSaves?: Map<string, Promise<unknown>> };
const saves = (gw.__forgeCloudSaves ??= new Map());
async function saveCloud(projectId: string, cfg: CloudConfig) {
  const file = configFile(projectId);
  const body = JSON.stringify(cfg, null, 2);
  const run = (saves.get(file) ?? Promise.resolve()).then(async () => {
    await fs.mkdir(dir(projectId), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
  });
  saves.set(file, run.catch(() => undefined));
  await run;
}

/** Read-modify-write of the config, serialised per project so concurrent requests don't lose updates. */
const gu = globalThis as unknown as { __forgeCloudUpdates?: Map<string, Promise<unknown>> };
const writing = (gu.__forgeCloudUpdates ??= new Map());
export function updateCloud(projectId: string, fn: (cfg: CloudConfig) => void) {
  const prev = writing.get(configFile(projectId)) ?? Promise.resolve();
  const next = prev.then(async () => {
    const cfg = await getCloud(projectId);
    if (!cfg) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
    fn(cfg);
    await saveCloud(projectId, cfg);
    return cfg;
  });
  writing.set(configFile(projectId), next.catch(() => undefined));
  return next;
}

// ---------- Engine and connections ----------

// The engine of each project, remembered so every query doesn't re-read config.json.
const ge = globalThis as unknown as { __forgeCloudEngines?: Map<string, { engine: Engine; pg: { role: string; password: string } | null }> };
const engines = (ge.__forgeCloudEngines ??= new Map());

async function engineInfo(id: string) {
  const base = baseId(id);
  let e = engines.get(base);
  if (!e) {
    const cfg = await getCloud(base);
    e = {
      engine: cfg?.engine === "postgres" ? "postgres" : "sqlite",
      pg: cfg?.engine === "postgres" && cfg.pg ? { role: cfg.pg.role, password: openBox(PG_PURPOSE, cfg.pg.password) } : null,
    };
    engines.set(base, e);
  }
  return e;
}

/** Forget the remembered engine (after enabling, moving or destroying). */
export function forgetEngine(projectId: string) {
  engines.delete(baseId(projectId));
}

/** The project's database engine: "sqlite" (default) or "postgres". */
export async function cloudEngine(projectId: string): Promise<Engine> {
  return (await engineInfo(projectId)).engine;
}

/** Where a Postgres data id lives and the project role that may use it. */
export async function pgTarget(dataId: string): Promise<PgTarget> {
  const e = await engineInfo(dataId);
  if (e.engine !== "postgres" || !e.pg) throw new CloudError("This project's database isn't on PostgreSQL.", 409);
  return { database: pgDatabaseName(dataId), user: e.pg.role, password: e.pg.password };
}

/** Make sure the project's role and its main database exist (Postgres projects). */
export async function ensurePgDatabase(projectId: string) {
  const t = await pgTarget(baseId(projectId));
  await ensureRole(t.user, t.password);
  if (!(await databaseExists(t.database))) await createDatabase(t.database, t.user);
}

/** A fresh role and password for a project that is about to use Postgres. */
export function newPgCredentials(projectId: string) {
  return { role: pgRoleName(projectId), password: seal(PG_PURPOSE, crypto.randomBytes(24).toString("base64url")) };
}

/** Size of the project's database, in bytes. */
export async function databaseSize(projectId: string) {
  if ((await cloudEngine(projectId)) === "postgres") return pgDatabaseSize(pgDatabaseName(projectId));
  const s = await fs.stat(dbFile(projectId)).catch(() => null);
  return s?.size ?? 0;
}

/** Close this process's connections to the project's database (Windows won't delete an open file). */
export async function closeDatabase(projectId: string) {
  closeSqlite(dbFile(projectId));
  if ((await cloudEngine(projectId).catch(() => "sqlite")) === "postgres") await closePgPool(pgDatabaseName(projectId));
}

/** Close and reopen the project's database connections (agent "restart"). */
export async function reopenDatabase(projectId: string) {
  await closeDatabase(projectId);
  await open(projectId).tables();
}

/** Rows of a read-only query, for checks that look at the schema. */
export async function readOnlyQuery(projectId: string, sql: string) {
  return open(projectId).transaction((tx) => tx.all<Record<string, unknown>>(sql), { readOnly: true });
}

export const cloudDir = (projectId: string) => dir(projectId);
/** The SQLite file behind a project's Cloud database (SQLite projects: backups, export). */
export const cloudDbFile = (projectId: string) => dbFile(projectId);

async function requireCloud(projectId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  return cfg;
}

/**
 * A project's database (a data id: the project, "<project>@live" or a draft),
 * on whichever engine the project uses, with the bookkeeping tables in place.
 * The engine is looked up on each call, so a project that moves to Postgres
 * is followed at once.
 */
class ProjectDb implements CloudDb {
  constructor(private readonly id: string) {}
  private async impl(): Promise<CloudDb> {
    const e = await engineInfo(this.id);
    if (e.engine === "postgres") return new PgDb(await pgTarget(this.id));
    return new SqliteDb(dbFile(this.id));
  }
  private async call<T>(fn: (d: CloudDb) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.impl());
    } catch (e) {
      // The project's main Postgres database went missing (dropped by hand, new server): make it again, once.
      // The project moved to Postgres while this query waited for its SQLite file.
      if (e instanceof EngineMovedError) return fn(await this.impl());
      if ((e as { code?: string }).code === "3D000" && !this.id.includes("@")) {
        await ensurePgDatabase(this.id);
        return fn(await this.impl());
      }
      throw e;
    }
  }
  engine() {
    return cloudEngine(this.id);
  }
  all<T = Row>(sql: string, params?: Param[]) {
    return this.call((d) => d.all<T>(sql, params));
  }
  get<T = Row>(sql: string, params?: Param[]) {
    return this.call((d) => d.get<T>(sql, params));
  }
  run(sql: string, params?: Param[]) {
    return this.call((d) => d.run(sql, params));
  }
  exec(sql: string) {
    return this.call((d) => d.exec(sql));
  }
  transaction<T>(fn: (tx: CloudDb) => Promise<T>, opts?: { readOnly?: boolean }) {
    return this.call((d) => d.transaction(fn, opts));
  }
  ensure(ddl: string) {
    return this.call((d) => d.ensure(ddl));
  }
  tables() {
    return this.call((d) => d.tables());
  }
  columns(table: string) {
    return this.call((d) => d.columns(table));
  }
  foreignKeys(table: string) {
    return this.call((d) => d.foreignKeys(table));
  }
  indexedColumns(table: string) {
    return this.call((d) => d.indexedColumns(table));
  }
}

/** The project's database, with Forge's bookkeeping tables in place. */
export function openDatabase(projectId: string): CloudDb {
  return open(projectId);
}
function open(projectId: string): CloudDb {
  return new ProjectDb(projectId);
}

/** Forget a project's backend entirely (used when the project is purged). */
export async function destroyCloud(projectId: string) {
  const cfg = await getCloud(projectId).catch(() => null);
  for (const f of [dbFile(projectId), dbFile(`${baseId(projectId)}@live`)]) closeSqlite(f);
  if (cfg?.pg?.role) {
    // Test, Live, drafts and backups: every database the project's role owns, then the role.
    for (const d of await ownedDatabases(cfg.pg.role).catch(() => [] as string[])) await dropDatabase(d).catch((e) => console.error("[cloud] drop", d, e));
    await dropRole(cfg.pg.role).catch((e) => console.error("[cloud] drop role", e));
  }
  forgetEngine(projectId);
  // cloud-envs remembers which projects have a Live database.
  (globalThis as unknown as { __forgeCloudLive?: Set<string> }).__forgeCloudLive?.delete(`${baseId(projectId)}@live`);
  await fs.rm(dir(projectId), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

export async function enableCloud(projectId: string) {
  const existing = await getCloud(projectId);
  if (existing?.enabled) return existing;
  const cfg: CloudConfig = existing ?? {
    enabled: true,
    enabledAt: new Date().toISOString(),
    anonKey: `fca_${crypto.randomBytes(18).toString("base64url")}`,
    jwtSecret: crypto.randomBytes(32).toString("base64url"),
    policies: {},
    secrets: {},
    requestedSecrets: [],
    // New backends get the server's default engine; an existing config keeps its own.
    engine: defaultEngine(),
  };
  cfg.enabled = true;
  cfg.enabledAt ??= new Date().toISOString();
  if (cfg.engine === "postgres" && !cfg.pg) cfg.pg = newPgCredentials(projectId);
  await saveCloud(projectId, cfg);
  forgetEngine(projectId);
  if (cfg.engine === "postgres") {
    try {
      await ensurePgDatabase(projectId);
    } catch (e) {
      throw new CloudError(`The PostgreSQL database for this app couldn't be created: ${e instanceof Error ? e.message : String(e)}`, 503);
    }
  }
  await open(projectId).tables();
  return cfg;
}

/** Turn a column list from either engine into the shape the API has always returned. */
const publicColumns = (cols: ColumnInfo[]) => cols.map(({ name, type, notnull, pk }) => ({ name, type, notnull: Number(notnull), pk: Number(pk) }));
// ---------- Migrations ----------

/** Statements that would reach outside the project's own database. */
const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|VACUUM|load_extension)\b/i;
/**
 * The Postgres equivalents. The project role can't do most of these anyway
 * (no superuser, owns only its own databases); this is the second fence, and
 * it keeps a migration in its one transaction.
 */
const FORBIDDEN_PG =
  /\b(ATTACH|DETACH|PRAGMA|LOAD_EXTENSION|COPY|VACUUM|LISTEN|NOTIFY|DBLINK|LO_IMPORT|LO_EXPORT|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|PG_SLEEP|SET\s+ROLE|SET\s+SESSION|RESET\s+ROLE|ALTER\s+(ROLE|USER|DATABASE|SYSTEM)|(CREATE|DROP)\s+(ROLE|USER|DATABASE|EXTENSION|TABLESPACE|SUBSCRIPTION|PUBLICATION|SERVER)|GRANT|REVOKE)\b|(^|;)\s*(COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION|ABORT|SAVEPOINT|RELEASE)\b/i;

/** Refuse SQL that reaches outside the project's database, for the project's engine. */
export async function checkSqlScope(projectId: string, sql: string) {
  if ((await cloudEngine(projectId)) === "postgres") {
    if (FORBIDDEN_PG.test(sql)) throw new CloudError("Migrations can't use ATTACH, PRAGMA, COPY, roles, grants, extensions, other databases or transaction control.");
  } else if (FORBIDDEN.test(sql)) throw new CloudError("Migrations can't use ATTACH, DETACH, PRAGMA, VACUUM or extensions.");
}

export async function proposeMigration(projectId: string, description: string, sql: string) {
  await requireCloud(projectId);
  await checkSqlScope(projectId, sql);
  if (/\b(_forge_migrations)\b/i.test(sql) || /\b(DROP|ALTER)\s+TABLE\s+(IF\s+EXISTS\s+)?("?)auth_users\b/i.test(sql)) {
    throw new CloudError(`${getBrand().shortName}'s own tables can't be changed by a migration.`);
  }
  const id = crypto.randomUUID();
  await open(projectId).run("INSERT INTO _forge_migrations (id, description, sql, created_at) VALUES (?, ?, ?, ?)", [
    id,
    description.slice(0, 200),
    sql,
    new Date().toISOString(),
  ]);
  return id;
}

export type Migration = { id: string; description: string; sql: string; status: string; error: string | null; created_at: string; applied_at: string | null };

export async function listMigrations(projectId: string) {
  await requireCloud(projectId);
  return open(projectId).all<Migration>("SELECT * FROM _forge_migrations ORDER BY created_at DESC");
}

/** Apply a pending migration in one transaction; a failure changes nothing. */
export async function applyMigration(projectId: string, id: string) {
  await requireCloud(projectId);
  const db = open(projectId);
  const m = await db.get<Migration>("SELECT * FROM _forge_migrations WHERE id = ?", [id]);
  if (!m) throw new CloudError("Migration not found", 404);
  if (m.status !== "pending") throw new CloudError(`This migration is already ${m.status}.`);
  try {
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.run("UPDATE _forge_migrations SET status = 'applied', applied_at = ?, error = NULL WHERE id = ?", [new Date().toISOString(), id]);
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.run("UPDATE _forge_migrations SET status = 'failed', error = ? WHERE id = ?", [error.slice(0, 1000), id]);
    throw new CloudError(`The migration failed and nothing was changed: ${error}`);
  }
  return m;
}

export async function rejectMigration(projectId: string, id: string) {
  await requireCloud(projectId);
  const r = await open(projectId).run("UPDATE _forge_migrations SET status = 'rejected' WHERE id = ? AND status = 'pending'", [id]);
  if (!r.changes) throw new CloudError("No pending migration with that id.", 404);
}

// ---------- Introspection and queries ----------

async function columns(projectId: string, table: string) {
  return publicColumns(await open(projectId).columns(table));
}

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function listTables(projectId: string) {
  const cfg = await requireCloud(projectId);
  const db = open(projectId);
  const names = (await db.tables()).filter((n) => !INTERNAL.test(n));
  const out = [];
  for (const name of names) {
    out.push({
      name,
      columns: await columns(projectId, name),
      rows: Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${quoteIdent(name)}`))?.n ?? 0),
      policy: cfg.policies[name] ?? DEFAULT_POLICY,
    });
  }
  return out;
}

/** Read-only SQL for the agent: a SELECT on a read-only connection (or READ ONLY transaction), 50 rows at most. */
export async function queryDatabase(projectId: string, sql: string): Promise<Record<string, unknown>[]> {
  await requireCloud(projectId);
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new CloudError("Only SELECT queries can be run here.");
  await checkSqlScope(projectId, sql).catch(() => {
    throw new CloudError("Only SELECT queries can be run here.");
  });
  const rows = (await open(projectId).transaction((tx) => tx.all<Record<string, unknown>>(sql), { readOnly: true })).slice(0, 50);
  return rows.map((r) => ({ ...r, ...("password_hash" in r ? { password_hash: "[hidden]" } : {}) }));
}

export async function setPolicy(projectId: string, table: string, policy: Policy) {
  const cfg = await requireCloud(projectId);
  if (!IDENT.test(table) || INTERNAL.test(table)) throw new CloudError("Unknown table");
  const ok = (a: string) => a === "public" || a === "authenticated" || a === "owner";
  if (!ok(policy.read) || !ok(policy.write)) throw new CloudError("Access must be public, authenticated or owner.");
  if ((policy.read === "owner" || policy.write === "owner") && !(await columns(projectId, table)).some((c) => c.name === "user_id")) {
    throw new CloudError(`"owner" access needs a user_id column on ${table}.`);
  }
  cfg.policies[table] = policy;
  await saveCloud(projectId, cfg);
}

export async function listAuthUsers(projectId: string) {
  await requireCloud(projectId);
  return open(projectId).all("SELECT id, email, created_at FROM auth_users ORDER BY created_at DESC LIMIT 100");
}
// ---------- Secrets ----------

export async function setSecret(projectId: string, name: string, value: string) {
  const cfg = await requireCloud(projectId);
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new CloudError("Secret names use capitals, digits and underscores, like STRIPE_KEY.");
  if (!value) throw new CloudError("A secret needs a value.");
  cfg.secrets[name] = { ...seal(SECRETS_PURPOSE, value), updatedAt: new Date().toISOString() };
  cfg.requestedSecrets = cfg.requestedSecrets.filter((r) => r.name !== name);
  await saveCloud(projectId, cfg);
}

export async function deleteSecret(projectId: string, name: string) {
  const cfg = await requireCloud(projectId);
  delete cfg.secrets[name];
  await saveCloud(projectId, cfg);
}

/**
 * Server-side only: secret values never reach the agent or the browser. A
 * project secret wins; otherwise the workspace's secret of that name is used.
 */
export async function readSecret(projectId: string, name: string) {
  const cfg = await getCloud(projectId);
  const box = cfg?.secrets[name];
  if (box) return openBox(SECRETS_PURPOSE, box);
  const ws = await projectWorkspace(projectId);
  return ws ? readWorkspaceSecret(ws, name) : null;
}

/** Names of the workspace secrets this project inherits (not overridden by its own). */
export async function inheritedSecretNames(projectId: string) {
  const cfg = await getCloud(projectId);
  const ws = await projectWorkspace(projectId);
  if (!ws) return [];
  return (await workspaceSecretNames(ws)).filter((n) => !cfg?.secrets[n]);
}

async function projectWorkspace(projectId: string) {
  const { db } = await import("./db");
  const p = await db.project.findUnique({ where: { id: baseId(projectId) }, select: { workspaceId: true } }).catch(() => null);
  return p?.workspaceId ?? null;
}

export async function requestSecret(projectId: string, name: string, description: string) {
  const cfg = await requireCloud(projectId);
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new CloudError("Secret names use capitals, digits and underscores, like STRIPE_KEY.");
  const inherited = (await inheritedSecretNames(projectId)).includes(name);
  if (!inherited && !cfg.requestedSecrets.some((r) => r.name === name)) cfg.requestedSecrets.push({ name, description: description.slice(0, 200) });
  await saveCloud(projectId, cfg);
  return !!cfg.secrets[name] || inherited;
}

// ---------- App-facing auth and REST ----------

async function signToken(cfg: CloudConfig, user: { id: string; email: string }) {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setAudience("forge-cloud")
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(cfg.jwtSecret));
}

export async function appUser(cfg: CloudConfig, authorization: string | null) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(cfg.jwtSecret), { audience: "forge-cloud" });
    return { id: String(payload.sub), email: String(payload.email) };
  } catch {
    return null;
  }
}

export async function signUp(projectId: string, cfg: CloudConfig, email: string, password: string) {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new CloudError("Enter a valid email address.");
  if (password.length < 8) throw new CloudError("Passwords need at least 8 characters.");
  const db = open(projectId);
  if (await db.get("SELECT 1 FROM auth_users WHERE email = ?", [address])) throw new CloudError("An account with this email already exists.", 409);
  const user = { id: crypto.randomUUID(), email: address };
  await db.run("INSERT INTO auth_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", [
    user.id,
    address,
    await hashPassword(password),
    new Date().toISOString(),
  ]);
  return { user, token: await signToken(cfg, user) };
}

/** A session for an existing or new app user (sign-in by emailed code). */
export async function sessionFor(projectId: string, cfg: CloudConfig, email: string, { create = false } = {}) {
  const address = email.trim().toLowerCase();
  const db = open(projectId);
  let row = await db.get<{ id: string; email: string }>("SELECT id, email FROM auth_users WHERE email = ?", [address]);
  if (!row) {
    if (!create) throw new CloudError("There is no account with this email.", 404);
    row = { id: crypto.randomUUID(), email: address };
    await db.run("INSERT INTO auth_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", [
      row.id,
      address,
      await hashPassword(crypto.randomBytes(24).toString("base64url")),
      new Date().toISOString(),
    ]);
  }
  const user = { id: row.id, email: row.email };
  return { user, token: await signToken(cfg, user) };
}

export async function signIn(projectId: string, cfg: CloudConfig, email: string, password: string) {
  const row = await open(projectId).get<{ id: string; email: string; password_hash: string }>(
    "SELECT id, email, password_hash FROM auth_users WHERE email = ?",
    [email.trim().toLowerCase()],
  );
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new CloudError("Wrong email or password.", 401);
  const user = { id: row.id, email: row.email };
  return { user, token: await signToken(cfg, user) };
}

function allowed(access: Access, user: { id: string } | null) {
  return access === "public" || !!user;
}

const OPS: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE" };
const RESERVED = new Set(["order", "limit", "offset", "select"]);

/**
 * The app's data API, in the style of PostgREST/Supabase:
 *   GET    /rest/todos?done=eq.0&order=created_at.desc&limit=20
 *   POST   /rest/todos            (object or array)
 *   PATCH  /rest/todos?id=eq.<id> (object)
 *   DELETE /rest/todos?id=eq.<id>
 * Access rules: public, authenticated, or owner (rows whose user_id is the
 * signed-in user). Inserts by a signed-in user get user_id filled in.
 *
 * The SQL is built from the table's real column names only (anything else is
 * refused), every name is quoted, and every value is a bound parameter, on
 * both engines.
 */
export async function rest(
  projectId: string,
  cfg: CloudConfig,
  method: string,
  table: string,
  params: URLSearchParams,
  body: unknown,
  user: { id: string } | null,
) {
  if (!IDENT.test(table) || INTERNAL.test(table)) throw new CloudError("Unknown table", 404);
  const db = open(projectId);
  const pgEngine = (await db.engine()) === "postgres";
  const cols = await db.columns(table);
  if (!cols.length) throw new CloudError(`There is no table called ${table}.`, 404);
  const names = new Set(cols.map((c) => c.name));
  const typeOf = (k: string) => cols.find((c) => c.name === k)?.type ?? "";
  const value = (k: string, v: unknown): Param => (pgEngine ? pgValue(v, typeOf(k)) : toSql(v));
  const policy = cfg.policies[table] ?? DEFAULT_POLICY;
  const owned = names.has("user_id");
  const t = quoteIdent(table);

  // WHERE from filters, plus the owner rule.
  const where: string[] = [];
  const args: Param[] = [];
  for (const [col, raw] of params) {
    if (RESERVED.has(col)) continue;
    if (!names.has(col)) throw new CloudError(`Unknown column ${col}`);
    const m = raw.match(/^(eq|neq|gt|gte|lt|lte|like|is)\.([\s\S]*)$/);
    if (!m) throw new CloudError(`Use ${col}=eq.value style filters.`);
    const c = quoteIdent(col);
    if (m[1] === "is") {
      where.push(`${c} IS ${m[2] === "null" ? "NULL" : "NOT NULL"}`);
      continue;
    }
    // SQLite's LIKE ignores case; ILIKE does the same on Postgres, on any column type.
    where.push(pgEngine && m[1] === "like" ? `CAST(${c} AS TEXT) ILIKE ?` : `${c} ${OPS[m[1]]} ?`);
    args.push(m[2]);
  }
  const needOwner = (method === "GET" ? policy.read : policy.write) === "owner";
  if (needOwner) {
    if (!user) throw new CloudError("Sign in to do that.", 401);
    where.push(`"user_id" = ?`);
    args.push(user.id);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  // Postgres reports bad values (a word in a number column…) as errors of the request, like SQLite's constraint errors.
  const sqlErr = (e: unknown) =>
    e instanceof CloudError ? e : pgEngine && isSqlError(e) ? new CloudError((e as Error).message) : e;

  if (method === "GET") {
    if (!allowed(policy.read, user)) throw new CloudError("Sign in to see this.", 401);
    let sql = `SELECT * FROM ${t}${whereSql}`;
    const order = params.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      if (!names.has(col)) throw new CloudError(`Unknown column ${col}`);
      sql += ` ORDER BY ${quoteIdent(col)} ${dir === "desc" ? "DESC" : "ASC"}`;
    }
    sql += ` LIMIT ${Math.min(1000, Math.max(1, Number(params.get("limit") ?? 100) || 100))}`;
    sql += ` OFFSET ${Math.max(0, Number(params.get("offset") ?? 0) || 0)}`;
    try {
      return await db.all(sql, args);
    } catch (e) {
      throw sqlErr(e);
    }
  }

  if (!allowed(policy.write, user)) throw new CloudError("Sign in to do that.", 401);

  if (method === "POST") {
    const rows = (Array.isArray(body) ? body : [body]).slice(0, 500) as Record<string, unknown>[];
    const idCol = cols.find((c) => c.name === "id");
    // Tables follow the convention of a text id filled in by the server (SQLite: declared TEXT; Postgres: text/uuid with no default).
    const fillId =
      !!idCol &&
      (pgEngine ? /^(text|uuid|character varying.*)$/i.test(idCol.type) && idCol.dflt_value === null : idCol.type.toUpperCase() === "TEXT");
    try {
      return await db.transaction(async (tx) => {
        const out: unknown[] = [];
        for (const r of rows) {
          if (!r || typeof r !== "object") throw new CloudError("Send an object or an array of objects.");
          const row: Record<string, unknown> = { ...r };
          if (owned && user) row.user_id = user.id;
          if (fillId && row.id === undefined) row.id = crypto.randomUUID();
          const keys = Object.keys(row).filter((k) => names.has(k));
          if (!keys.length) throw new CloudError("None of those fields are columns of this table.");
          const insert = `INSERT INTO ${t} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
          const values = keys.map((k) => value(k, row[k]));
          if (pgEngine) out.push((await tx.all(`${insert} RETURNING *`, values))[0]);
          else {
            const info = await tx.run(insert, values);
            out.push(await tx.get(`SELECT * FROM ${t} WHERE rowid = ?`, [info.lastInsertRowid ?? null]));
          }
        }
        return out;
      });
    } catch (e) {
      throw e instanceof CloudError ? e : new CloudError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!where.length || (needOwner && where.length === 1)) {
    throw new CloudError("Updates and deletes need a filter, e.g. ?id=eq.<id>.");
  }
  try {
    if (method === "PATCH") {
      const patch = (body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(patch).filter((k) => names.has(k) && k !== "user_id");
      if (!keys.length) throw new CloudError("Nothing to update.");
      const info = await db.run(`UPDATE ${t} SET ${keys.map((k) => `${quoteIdent(k)} = ?`).join(", ")}${whereSql}`, [
        ...keys.map((k) => value(k, patch[k])),
        ...args,
      ]);
      return { updated: Number(info.changes) };
    }
    if (method === "DELETE") {
      const info = await db.run(`DELETE FROM ${t}${whereSql}`, args);
      return { deleted: Number(info.changes) };
    }
  } catch (e) {
    throw sqlErr(e);
  }
  throw new CloudError("Method not allowed", 405);
}

function toSql(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** A JSON value as a Postgres parameter for a column of this type. */
export function pgValue(v: unknown, type: string): Param {
  if (v === null || v === undefined) return null;
  const t = type.toLowerCase();
  if (typeof v === "boolean") return t === "boolean" ? v : v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  if (Array.isArray(v) && t.endsWith("[]")) return v;
  return JSON.stringify(v);
}

/** Newest rows first: SQLite's rowid, Postgres's physical row order (ctid). */
export async function rowOrder(db: CloudDb) {
  return (await db.engine()) === "postgres" ? "ctid" : "rowid";
}

export async function browseTable(projectId: string, table: string) {
  await requireCloud(projectId);
  if (!IDENT.test(table) || INTERNAL.test(table)) throw new CloudError("Unknown table", 404);
  const db = open(projectId);
  return db.all(`SELECT * FROM ${quoteIdent(table)} ORDER BY ${await rowOrder(db)} DESC LIMIT 50`);
}

/** The client file written into the app when Cloud is enabled. */
export function clientSource(projectId: string, anonKey: string) {
  return `// Cloud client: database, auth and access rules for this app.
// Generated by the platform. Safe to commit: the anon key only identifies the project.
const URL = import.meta.env.VITE_FORGE_CLOUD_URL ?? ${JSON.stringify(cloudUrl(projectId))};
const ANON_KEY = ${JSON.stringify(anonKey)};
const TOKEN_KEY = "forge-cloud-session";

type User = { id: string; email: string };
type Session = { token: string; user: User };
type Filter = Record<string, string | number | boolean | null>;
const listeners = new Set<(user: User | null) => void>();

function session(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "null");
  } catch {
    return null;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = session();
  const res = await fetch(URL + path, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "content-type": "application/json",
      ...(s ? { authorization: "Bearer " + s.token } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Request failed (" + res.status + ")");
  return body as T;
}

function query(filter: Filter = {}, extra: Record<string, string> = {}) {
  const p = new URLSearchParams(extra);
  for (const [k, v] of Object.entries(filter)) p.set(k, v === null ? "is.null" : "eq." + (v === true ? 1 : v === false ? 0 : v));
  const s = p.toString();
  return s ? "?" + s : "";
}

export const cloud = {
  from<T = Record<string, unknown>>(table: string) {
    return {
      list: (opts: { filter?: Filter; order?: string; desc?: boolean; limit?: number } = {}) =>
        call<T[]>("/rest/" + table + query(opts.filter, {
          ...(opts.order ? { order: opts.order + (opts.desc ? ".desc" : ".asc") } : {}),
          ...(opts.limit ? { limit: String(opts.limit) } : {}),
        })),
      insert: (row: Partial<T> | Partial<T>[]) => call<T[]>("/rest/" + table, { method: "POST", body: JSON.stringify(row) }),
      update: (filter: Filter, patch: Partial<T>) =>
        call<{ updated: number }>("/rest/" + table + query(filter), { method: "PATCH", body: JSON.stringify(patch) }),
      remove: (filter: Filter) => call<{ deleted: number }>("/rest/" + table + query(filter), { method: "DELETE" }),
    };
  },
  auth: {
    user: (): User | null => session()?.user ?? null,
    async signUp(email: string, password: string) {
      const s = await call<Session>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
      localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
      listeners.forEach((fn) => fn(s.user));
      return s.user;
    },
    async signIn(email: string, password: string) {
      const s = await call<Session>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
      listeners.forEach((fn) => fn(s.user));
      return s.user;
    },
    /** "Continue with" the platform: sends the person to the platform to sign in, then back here. Call completeSignIn() on load. */
    signInWithForge() {
      const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("forge-cloud-state", state);
      const back = location.origin + location.pathname;
      const editor = URL.slice(0, URL.indexOf("/cloud/v1/"));
      location.href = editor + "/oauth/forge?project=" + encodeURIComponent(URL.split("/").pop()!) + "&redirect_uri=" + encodeURIComponent(back) + "&state=" + state;
    },
    /** "Continue with Google" (when it's on in Cloud → Settings): sends the person to Google, then back here. Call completeSignIn() on load. */
    signInWithGoogle() {
      const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("forge-cloud-state", state);
      const back = location.origin + location.pathname;
      location.href = URL + "/auth/google?redirect_uri=" + encodeURIComponent(back) + "&state=" + state;
    },
    /** Finish platform or Google sign-in after the redirect back; returns the user, or null if there was nothing to finish. */
    async completeSignIn(): Promise<User | null> {
      const params = new URLSearchParams(location.search);
      const failed = params.get("forge_error");
      if (failed) {
        history.replaceState(null, "", location.pathname + location.hash);
        throw new Error(failed);
      }
      const code = params.get("forge_code");
      if (!code) return null;
      const ok = params.get("state") === sessionStorage.getItem("forge-cloud-state");
      sessionStorage.removeItem("forge-cloud-state");
      history.replaceState(null, "", location.pathname + location.hash);
      if (!ok) throw new Error("The sign-in didn't match. Try again.");
      const s = await call<Session>("/auth/forge", { method: "POST", body: JSON.stringify({ code }) });
      localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
      listeners.forEach((fn) => fn(s.user));
      return s.user;
    },
    /** Email a six-digit sign-in code (when "Email code" sign-in is on). */
    sendCode: (email: string) => call<{ sent: boolean }>("/auth/otp", { method: "POST", body: JSON.stringify({ email }) }),
    /** Sign in with the emailed code; makes the account if sign-ups are open. */
    async verifyCode(email: string, code: string) {
      const s = await call<Session>("/auth/verify", { method: "POST", body: JSON.stringify({ email, code }) });
      localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
      listeners.forEach((fn) => fn(s.user));
      return s.user;
    },
    signOut() {
      localStorage.removeItem(TOKEN_KEY);
      listeners.forEach((fn) => fn(null));
    },
    onChange(fn: (user: User | null) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  },
  ai: {
    /** Chat with an AI model through Forge. "fast" is cheaper; "smart" is better at hard tasks. */
    async chat(
      messages: { role: "user" | "assistant"; content: string }[],
      opts: { system?: string; model?: "fast" | "smart"; maxTokens?: number } = {},
    ): Promise<string> {
      const r = await call<{ text: string }>("/ai/chat", { method: "POST", body: JSON.stringify({ messages, ...opts }) });
      return r.text;
    },
    /** One prompt in, text out. */
    generate(prompt: string, opts: { system?: string; model?: "fast" | "smart"; maxTokens?: number } = {}) {
      return cloud.ai.chat([{ role: "user", content: prompt }], opts);
    },
  },
  email: {
    /** Send an email from the app. Until an email account is connected, messages are kept in the Cloud outbox. */
    send: (msg: { to: string; subject: string; text?: string; html?: string }) =>
      call<{ id: string; status: "sent" | "captured" }>("/email/send", { method: "POST", body: JSON.stringify(msg) }),
  },
  functions: {
    /** Call one of the app's server functions (functions/<name>.ts). Returns its JSON, or text. */
    async invoke<T = unknown>(name: string, body?: unknown, opts: { method?: string } = {}): Promise<T> {
      const s = session();
      const method = opts.method ?? (body === undefined ? "GET" : "POST");
      const res = await fetch(URL + "/functions/" + name, {
        method,
        headers: { apikey: ANON_KEY, "content-type": "application/json", ...(s ? { authorization: "Bearer " + s.token } : {}) },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {}
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? "Function failed (" + res.status + ")");
      return data as T;
    },
  },
  workflows: {
    /** Start a run of workflows/<name>.json; the input is checked against its schema. */
    start: (name: string, input: unknown = {}) => call<{ id: string; status: string }>("/workflows/" + name + "/runs", { method: "POST", body: JSON.stringify({ input }) }),
    /** A run with each step's status and output. */
    get: (runId: string) => call<{ id: string; status: string; steps: { id: string; status: string; output: unknown }[] }>("/workflows/runs/" + runId),
    /** Send an event a run is waiting for (an "event" step). */
    send: (runId: string, event: string, data?: unknown) => call<{ ok: boolean }>("/workflows/runs/" + runId + "/events", { method: "POST", body: JSON.stringify({ event, data }) }),
  },
  storage: {
    /** Files in a bucket: "public" (anyone can view), "uploads" (only the uploader), or one made in the Cloud tab. */
    from(bucket: string) {
      const p = (path: string) => bucket + "/" + path.split("/").map(encodeURIComponent).join("/");
      return {
        /** Upload a File/Blob (signed-in users only). Returns the stored path and, for public buckets, its URL. */
        async upload(path: string, file: Blob) {
          const s = session();
          const res = await fetch(URL + "/storage/object/" + p(path), {
            method: "PUT",
            headers: { apikey: ANON_KEY, "content-type": file.type || "application/octet-stream", ...(s ? { authorization: "Bearer " + s.token } : {}) },
            body: file,
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? "Upload failed (" + res.status + ")");
          return body as { path: string; size: number; contentType: string; url: string | null };
        },
        /** A plain URL for files in a public bucket (use it in <img src>). */
        publicUrl: (path: string) => URL + "/storage/public/" + p(path),
        /** A link to a private file that works for anyone until it expires (seconds, default 1 hour). */
        signedUrl: (path: string, expiresIn = 3600) =>
          call<{ url: string; expiresAt: string }>("/storage/sign/" + p(path), { method: "POST", body: JSON.stringify({ expiresIn }) }).then((r) => r.url),
        /** Download a file the signed-in user may read. */
        async download(path: string) {
          const s = session();
          const res = await fetch(URL + "/storage/object/" + p(path), { headers: { apikey: ANON_KEY, ...(s ? { authorization: "Bearer " + s.token } : {}) } });
          if (!res.ok) throw new Error("File not found");
          return res.blob();
        },
        list: (opts: { prefix?: string; limit?: number } = {}) =>
          call<{ path: string; size: number; content_type: string; updated_at: string; url: string | null }[]>(
            "/storage/list/" + bucket + "?" + new URLSearchParams({ prefix: opts.prefix ?? "", limit: String(opts.limit ?? 100) }),
          ),
        remove: (path: string) => call<{ deleted: number }>("/storage/object/" + p(path), { method: "DELETE" }),
      };
    },
  },
};
`;
}

export const CLIENT_PATH = "src/integrations/cloud/client.ts";
