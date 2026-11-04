import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensuredSet, pgGate, pgPool, type PgTarget, type PoolClient } from "./cloud-pg";

/**
 * One data-access interface for a Cloud project's database, whichever engine
 * it runs on. SQL is written with ? placeholders; the Postgres side turns them
 * into $1, $2… (never by pasting values in). Identifiers that come from users
 * are validated and quoted by the callers.
 */

export type Engine = "sqlite" | "postgres";
export type Row = Record<string, unknown>;
export type Param = string | number | bigint | boolean | null | Uint8Array | unknown[];
export type ColumnInfo = { name: string; type: string; notnull: number; pk: number; dflt_value: string | null };
export type ForeignKeyInfo = { table: string; from: string; to: string };

export interface CloudDb {
  engine(): Promise<Engine>;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  run(sql: string, params?: Param[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  /** A script of one or more statements; returns rows changed when the engine reports it. */
  exec(sql: string): Promise<number>;
  /** All or nothing. readOnly runs on a read-only connection (SQLite) or a READ ONLY transaction (Postgres). */
  transaction<T>(fn: (tx: CloudDb) => Promise<T>, opts?: { readOnly?: boolean }): Promise<T>;
  /** Create a bookkeeping table if needed; DDL in SQLite syntax, translated for Postgres. */
  ensure(ddl: string): Promise<void>;
  tables(): Promise<string[]>;
  columns(table: string): Promise<ColumnInfo[]>;
  foreignKeys(table: string): Promise<ForeignKeyInfo[]>;
  /** The first column of every index on the table. */
  indexedColumns(table: string): Promise<string[]>;
}

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;

/** True for errors the database raised about the SQL or the data (the caller's mistake, shown to them). */
export function isSqlError(e: unknown) {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !/^(08|53|57|58|XX)/.test(code)) return true;
  return /SQLITE|constraint|no such|syntax|datatype/i.test(e.message);
}

// ── SQLite ────────────────────────────────────────────────────────────────

type SqliteState = { db: DatabaseSync; busy: Promise<void> | null; moved?: boolean };

/** The database moved to another engine while this query waited: run it again on the new one. */
export class EngineMovedError extends Error {
  constructor() {
    super("The database moved to another engine.");
  }
}
const g = globalThis as unknown as { __forgeCloudSqlite?: Map<string, SqliteState> };
const sqliteHandles: Map<string, SqliteState> = (g.__forgeCloudSqlite ??= new Map());

const SQLITE_INIT = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS _forge_migrations (
    id TEXT PRIMARY KEY, description TEXT NOT NULL, sql TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', error TEXT,
    created_at TEXT NOT NULL, applied_at TEXT);
  CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL);
`;

function sqliteState(file: string) {
  let s = sqliteHandles.get(file);
  if (!s) {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(SQLITE_INIT);
    s = { db, busy: null };
    sqliteHandles.set(file, s);
  }
  return s;
}

export function closeSqlite(file: string) {
  sqliteHandles.get(file)?.db.close();
  sqliteHandles.delete(file);
}

/** The raw handle, for code that only exists for SQLite (VACUUM INTO, the move to Postgres). */
export function sqliteHandle(file: string) {
  return sqliteState(file).db;
}

/** Run fn on the raw handle once no transaction holds it (VACUUM can't run inside one). */
export async function withSqlite<T>(file: string, fn: (db: DatabaseSync) => T): Promise<T> {
  const s = sqliteState(file);
  while (s.busy) await s.busy;
  if (s.moved) throw new EngineMovedError();
  return fn(s.db);
}

/**
 * Hold a database for a long job (the move to Postgres): every other query on
 * it waits. release(true) closes it and sends the waiting queries to the
 * project's new engine; release(false) lets them carry on here.
 */
export async function holdSqlite(file: string) {
  const s = sqliteState(file);
  while (s.busy) await s.busy;
  let done!: () => void;
  s.busy = new Promise<void>((r) => (done = r));
  return {
    db: s.db,
    release(moved: boolean) {
      if (moved) {
        s.moved = true;
        s.db.close();
        if (sqliteHandles.get(file) === s) sqliteHandles.delete(file);
      }
      s.busy = null;
      done();
    },
  };
}

type SqliteValue = null | number | bigint | string | Uint8Array;
const sv = (params: Param[]) =>
  params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : Array.isArray(v) ? JSON.stringify(v) : v)) as SqliteValue[];

/**
 * Statements run synchronously, as before. A transaction holds the handle:
 * other statements on the same database wait until it ends, so nothing from
 * another request lands inside it.
 */
export class SqliteDb implements CloudDb {
  constructor(
    private readonly file: string,
    private readonly opts: { inTx?: DatabaseSync; readOnly?: boolean } = {},
  ) {}
  async engine(): Promise<Engine> {
    return "sqlite";
  }
  private async handle() {
    if (this.opts.inTx) return this.opts.inTx;
    const s = sqliteState(this.file);
    while (s.busy) await s.busy;
    if (s.moved) throw new EngineMovedError();
    return s.db;
  }
  async all<T = Row>(sql: string, params: Param[] = []) {
    return (await this.handle()).prepare(sql).all(...sv(params)) as T[];
  }
  async get<T = Row>(sql: string, params: Param[] = []) {
    return (await this.handle()).prepare(sql).get(...sv(params)) as T | undefined;
  }
  async run(sql: string, params: Param[] = []) {
    const r = (await this.handle()).prepare(sql).run(...sv(params));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  async exec(sql: string) {
    const db = await this.handle();
    const before = Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    db.exec(sql);
    return Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n) - before;
  }
  async transaction<T>(fn: (tx: CloudDb) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
    if (opts.readOnly) {
      const ro = new DatabaseSync(this.file, { readOnly: true });
      try {
        return await fn(new SqliteDb(this.file, { inTx: ro, readOnly: true }));
      } finally {
        ro.close();
      }
    }
    if (this.opts.inTx) return fn(this);
    const s = sqliteState(this.file);
    while (s.busy) await s.busy;
    if (s.moved) throw new EngineMovedError();
    let done!: () => void;
    s.busy = new Promise<void>((r) => (done = r));
    try {
      s.db.exec("BEGIN");
      try {
        const out = await fn(new SqliteDb(this.file, { inTx: s.db }));
        s.db.exec("COMMIT");
        return out;
      } catch (e) {
        s.db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      s.busy = null;
      done();
    }
  }
  async ensure(ddl: string) {
    (await this.handle()).exec(ddl);
  }
  async tables() {
    return (await this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name);
  }
  async columns(table: string) {
    return this.all<ColumnInfo>(`SELECT name, type, "notnull", pk, dflt_value FROM pragma_table_info(?)`, [table]);
  }
  async foreignKeys(table: string) {
    return this.all<ForeignKeyInfo>(`PRAGMA foreign_key_list(${quote(table)})`);
  }
  async indexedColumns(table: string) {
    const q = table.replace(/'/g, "''");
    return (
      await this.all<{ col: string }>(`SELECT i.name AS col FROM pragma_index_list('${q}') l JOIN pragma_index_info(l.name) i WHERE i.seqno = 0`)
    ).map((r) => String(r.col));
  }
}

// ── PostgreSQL ────────────────────────────────────────────────────────────

/** ? → $1, $2… outside strings, quoted names, comments and dollar-quoted bodies. */
export function pgPlaceholders(sql: string) {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const j = end < 0 ? sql.length : end;
      out += sql.slice(i, j + 1);
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const j = end < 0 ? sql.length : end;
      out += sql.slice(i, j);
      i = j - 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, j);
      i = j - 1;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      const j = end < 0 ? sql.length : end + tag.length;
      out += sql.slice(i, j);
      i = j - 1;
    } else if (c === "?") {
      out += `$${++n}`;
    } else out += c;
  }
  return out;
}

/** Bookkeeping DDL written for SQLite, made valid Postgres (ids become identities; integers hold millisecond times, so bigint). */
export function pgDdl(ddl: string) {
  return ddl
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY")
    .replace(/\bINTEGER\b/g, "BIGINT");
}

const pv = (params: Param[]) => params.map((v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v));

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<pg_Result | pg_Result[]> };
type pg_Result = { rows: Row[]; rowCount: number | null };

export const PG_INIT = `
  CREATE TABLE IF NOT EXISTS _forge_migrations (
    id TEXT PRIMARY KEY, description TEXT NOT NULL, sql TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', error TEXT,
    created_at TEXT NOT NULL, applied_at TEXT);
  CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL);
`;

export class PgDb implements CloudDb {
  constructor(
    private readonly target: PgTarget,
    private readonly client?: PoolClient,
  ) {}
  async engine(): Promise<Engine> {
    return "postgres";
  }
  /** One statement, always over the extended protocol: a second statement smuggled in is refused by the server. */
  private async q(sql: string, params: Param[] = []): Promise<pg_Result> {
    const conn = await this.conn();
    const r = await (conn as unknown as { query: (c: object) => Promise<pg_Result> }).query({
      text: params.length ? pgPlaceholders(sql) : sql,
      values: pv(params),
      queryMode: "extended",
    });
    return r;
  }
  private async conn(): Promise<Queryable> {
    if (this.client) return this.client as unknown as Queryable;
    await pgGate(this.target.database);
    const pool = pgPool(this.target);
    const done = ensuredSet(this.target.database);
    if (!done.has("__init")) {
      await pool.query(PG_INIT);
      done.add("__init");
    }
    return pool as unknown as Queryable;
  }
  async all<T = Row>(sql: string, params: Param[] = []) {
    return (await this.q(sql, params)).rows as T[];
  }
  async get<T = Row>(sql: string, params: Param[] = []) {
    return (await this.q(sql, params)).rows[0] as T | undefined;
  }
  async run(sql: string, params: Param[] = []) {
    return { changes: (await this.q(sql, params)).rowCount ?? 0 };
  }
  async exec(sql: string) {
    const conn = await this.conn();
    const r = await conn.query(sql);
    return (Array.isArray(r) ? r : [r]).reduce((n, x) => n + (x.rowCount ?? 0), 0);
  }
  async transaction<T>(fn: (tx: CloudDb) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
    if (this.client) return fn(this);
    await this.conn();
    const client = await pgPool(this.target).connect();
    try {
      await client.query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      try {
        const out = await fn(new PgDb(this.target, client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    } finally {
      client.release();
    }
  }
  async ensure(ddl: string) {
    const done = ensuredSet(this.target.database);
    if (done.has(ddl)) return;
    await this.exec(pgDdl(ddl));
    done.add(ddl);
  }
  async tables() {
    return (await this.all<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).map((r) => r.name);
  }
  async columns(table: string) {
    return this.all<ColumnInfo>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull::int AS "notnull",
         COALESCE((SELECT array_position(i.indkey::int2[], a.attnum) FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary), 0) AS pk,
         CASE WHEN a.attidentity <> '' THEN 'identity' ELSE pg_get_expr(d.adbin, d.adrelid) END AS dflt_value
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relname = ? AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [table],
    );
  }
  async foreignKeys(table: string) {
    return this.all<ForeignKeyInfo>(
      `SELECT rc.relname AS "table", a.attname AS "from", ra.attname AS "to"
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = k.confrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
       JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = k.confkey[1]
       WHERE k.contype = 'f' AND n.nspname = 'public' AND c.relname = ?`,
      [table],
    );
  }
  async indexedColumns(table: string) {
    return (
      await this.all<{ col: string }>(
        `SELECT a.attname AS col FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
         WHERE n.nspname = 'public' AND c.relname = ?`,
        [table],
      )
    ).map((r) => String(r.col));
  }
}
