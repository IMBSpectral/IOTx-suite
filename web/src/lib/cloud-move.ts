import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  CloudError,
  cloudDbFile,
  cloudDir,
  cloudEngine,
  forgetEngine,
  getCloud,
  newPgCredentials,
  updateCloud,
} from "./cloud";
import { holdSqlite, PgDb, type CloudDb, type Param } from "./cloud-db";
import { adminPool, closePgPool, createDatabase, databaseExists, dropDatabase, ensuredSet, ensureRole, pgDatabaseName } from "./cloud-pg";
import { open as openBox } from "./secret-box";

/**
 * "Move to PostgreSQL" (Cloud tab → Settings, workspace admins): copies a
 * SQLite project's schema and data (Test and, when it exists, Live) into its
 * own Postgres databases, checks the row count of every table, then switches
 * the project's engine. Nothing changes if any step fails. The SQLite files
 * are kept: a copy in backups/ (…-before-postgres.sqlite) and the originals
 * renamed to *.pre-postgres. While the copy runs, the app's requests to the
 * database wait (a few seconds for a typical app) and then go to Postgres.
 *
 * Types follow SQLite's own affinity rules, chosen so the app sees the same
 * values afterwards: INT… → bigint (an INTEGER PRIMARY KEY becomes an
 * identity column), REAL/FLOAT/DOUBLE → double precision, NUMERIC/DECIMAL →
 * numeric, BLOB → bytea, everything else (TEXT, VARCHAR, DATETIME, JSON,
 * BOOLEAN stored as 0/1…) → text or bigint as stored. BOOLEAN columns stay
 * numbers (0/1) because the app was written against those.
 */

const PG_PURPOSE = "forge-cloud-pg";
const qi = (n: string) => `"${n.replace(/"/g, '""')}"`;

type SqlCol = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type SqlFk = { id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string };
type SqlIndex = { name: string; unique: number; origin: string; partial: number };

export type MoveReport = {
  ok: true;
  environments: { env: "test" | "live"; database: string; tables: { table: string; sqlite: number; postgres: number }[] }[];
  warnings: string[];
  sqliteBackups: string[];
};

/** SQLite declared type → Postgres type, by SQLite's affinity rules. */
export function pgType(declared: string) {
  const t = declared.toUpperCase();
  if (t.includes("INT")) return "bigint";
  if (/CHAR|CLOB|TEXT/.test(t)) return "text";
  if (t === "BLOB") return "bytea";
  if (t === "") return "text";
  if (/REAL|FLOA|DOUB/.test(t)) return "double precision";
  if (/BOOL/.test(t)) return "bigint";
  if (/NUMERIC|DECIMAL/.test(t)) return "numeric";
  return "text";
}

const STRFTIME: Record<string, string> = { "%Y": "YYYY", "%m": "MM", "%d": "DD", "%H": "HH24", "%M": "MI", "%S": "SS", "%f": "SS.MS", "%j": "DDD", "%%": "%" };
function strftimeToPg(fmt: string) {
  let out = "";
  let lit = "";
  for (let i = 0; i < fmt.length; i++) {
    const code = fmt.slice(i, i + 2);
    if (STRFTIME[code]) {
      if (lit) out += `"${lit}"`;
      lit = "";
      out += STRFTIME[code];
      i++;
    } else lit += fmt[i];
  }
  if (lit) out += `"${lit}"`;
  return out;
}

/** A SQLite column default as a Postgres default, or null when it has no safe equivalent. */
export function pgDefault(raw: string, type: string): string | null {
  let x = raw.trim();
  while (/^\([\s\S]*\)$/.test(x)) x = x.slice(1, -1).trim();
  const utc = (f: string) => `to_char(now() AT TIME ZONE 'UTC', '${f}')`;
  if (/^(CURRENT_TIMESTAMP|datetime\(\s*'now'\s*\))$/i.test(x)) return type === "text" ? utc("YYYY-MM-DD HH24:MI:SS") : "CURRENT_TIMESTAMP";
  if (/^(CURRENT_DATE|date\(\s*'now'\s*\))$/i.test(x)) return type === "text" ? utc("YYYY-MM-DD") : "CURRENT_DATE";
  if (/^(CURRENT_TIME|time\(\s*'now'\s*\))$/i.test(x)) return type === "text" ? utc("HH24:MI:SS") : "CURRENT_TIME";
  const sf = x.match(/^strftime\(\s*'([^']*)'\s*,\s*'now'\s*\)$/i);
  if (sf) return utc(strftimeToPg(sf[1]).replace(/'/g, "''"));
  if (/^unixepoch\(\s*(?:'now'\s*)?\)$/i.test(x)) return "(extract(epoch from now()))::bigint";
  if (/^[-+]?\d+(\.\d+)?$/.test(x)) return x;
  if (/^'(?:[^']|'')*'$/.test(x)) return x;
  if (/^NULL$/i.test(x)) return "NULL";
  if (/^TRUE$/i.test(x)) return type === "boolean" ? "true" : "1";
  if (/^FALSE$/i.test(x)) return type === "boolean" ? "false" : "0";
  if (/^lower\(\s*hex\(\s*randomblob\(\s*16\s*\)\s*\)\s*\)$/i.test(x)) return "md5(random()::text || clock_timestamp()::text)";
  if (/^hex\(\s*randomblob\(\s*16\s*\)\s*\)$/i.test(x)) return "upper(md5(random()::text || clock_timestamp()::text))";
  return null;
}

type TablePlan = {
  name: string;
  cols: (SqlCol & { pgType: string; identity: boolean })[];
  pk: string[];
  fks: { from: string[]; table: string; to: string[] | null; onUpdate: string; onDelete: string }[];
  indexes: { name: string; unique: boolean; cols: string[] }[];
};

function plan(h: DatabaseSync, warnings: string[], env: string) {
  const tables = h.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  const plans: TablePlan[] = [];
  for (const t of tables) {
    const cols = h.prepare(`SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(t.name) as unknown as SqlCol[];
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const rowidAlias = pkCols.length === 1 && pkCols[0].type.toUpperCase() === "INTEGER" && !/WITHOUT\s+ROWID/i.test(t.sql);
    if (/\bCHECK\s*\(/i.test(t.sql)) warnings.push(`${env}: ${t.name} has CHECK rules; they weren't copied.`);
    if (/COLLATE\s+NOCASE/i.test(t.sql)) warnings.push(`${env}: ${t.name} compares some text without case (COLLATE NOCASE); on Postgres comparisons are case-sensitive.`);
    const fkRows = h.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(t.name) as unknown as SqlFk[];
    const fks = new Map<number, TablePlan["fks"][number]>();
    for (const f of fkRows) {
      const k = fks.get(f.id) ?? { from: [], table: f.table, to: f.to === null ? null : [], onUpdate: f.on_update, onDelete: f.on_delete };
      k.from.push(f.from);
      if (k.to && f.to !== null) k.to.push(f.to);
      fks.set(f.id, k);
    }
    const indexes: TablePlan["indexes"] = [];
    for (const ix of h.prepare(`SELECT name, "unique", origin, partial FROM pragma_index_list(?)`).all(t.name) as unknown as SqlIndex[]) {
      if (ix.origin === "pk") continue;
      if (ix.partial) {
        warnings.push(`${env}: the partial index ${ix.name} wasn't copied.`);
        continue;
      }
      const info = h.prepare(`SELECT cid, name FROM pragma_index_info(?) ORDER BY seqno`).all(ix.name) as { cid: number; name: string | null }[];
      if (info.some((i) => i.cid < 0 || !i.name)) {
        warnings.push(`${env}: the expression index ${ix.name} wasn't copied.`);
        continue;
      }
      const names = info.map((i) => String(i.name));
      const name = ix.origin === "u" || ix.name.startsWith("sqlite_") ? `${t.name}_${names.join("_")}_key`.slice(0, 63) : ix.name;
      indexes.push({ name, unique: !!ix.unique, cols: names });
    }
    plans.push({
      name: t.name,
      cols: cols.map((c) => ({ ...c, pgType: pgType(c.type), identity: rowidAlias && c.pk === 1 })),
      pk: pkCols.map((c) => c.name),
      fks: [...fks.values()],
      indexes,
    });
  }
  return plans;
}

function createTableSql(p: TablePlan, warnings: string[], env: string) {
  const defs = p.cols.map((c) => {
    let s = `${qi(c.name)} ${c.pgType}`;
    if (c.identity) s += " GENERATED BY DEFAULT AS IDENTITY";
    else if (c.dflt_value !== null) {
      const d = pgDefault(String(c.dflt_value), c.pgType);
      if (d === null) warnings.push(`${env}: the default of ${p.name}.${c.name} (${c.dflt_value}) has no Postgres equivalent and wasn't copied.`);
      else s += ` DEFAULT ${d}`;
    }
    if (c.notnull || c.identity) s += " NOT NULL";
    return s;
  });
  if (p.pk.length) defs.push(`PRIMARY KEY (${p.pk.map(qi).join(", ")})`);
  return `CREATE TABLE ${qi(p.name)} (${defs.join(", ")})`;
}

function value(v: unknown, type: string): Param {
  if (v === null || v === undefined) return null;
  if (type === "bytea") return v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v));
  if (type === "text") return v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : String(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return v as Param;
}

/** Copy one SQLite database into a new, empty Postgres database (one transaction). Returns per-table counts. */
async function copyInto(h: DatabaseSync, pgdb: CloudDb, warnings: string[], env: string) {
  const plans = plan(h, warnings, env);
  const counts: { table: string; sqlite: number; postgres: number }[] = [];
  await pgdb.transaction(async (tx) => {
    for (const p of plans) await tx.exec(createTableSql(p, warnings, env));
    for (const p of plans) {
      const total = Number((h.prepare(`SELECT count(*) AS n FROM ${qi(p.name)}`).get() as { n: number }).n);
      const names = p.cols.map((c) => c.name);
      const per = Math.max(1, Math.floor(30_000 / Math.max(1, names.length)));
      for (let offset = 0; offset < total; offset += 1000) {
        const rows = h.prepare(`SELECT * FROM ${qi(p.name)} LIMIT 1000 OFFSET ${offset}`).all() as Record<string, unknown>[];
        for (let i = 0; i < rows.length; i += per) {
          const chunk = rows.slice(i, i + per);
          const values: Param[] = [];
          const tuples = chunk.map((r) => {
            for (const c of p.cols) values.push(value(r[c.name], c.pgType));
            return `(${names.map(() => "?").join(", ")})`;
          });
          await tx.run(`INSERT INTO ${qi(p.name)} (${names.map(qi).join(", ")}) VALUES ${tuples.join(", ")}`, values);
        }
      }
      for (const c of p.cols.filter((x) => x.identity)) {
        await tx.get(
          `SELECT setval(pg_get_serial_sequence(?, ?), GREATEST(COALESCE(MAX(${qi(c.name)}), 0), 1), MAX(${qi(c.name)}) IS NOT NULL) FROM ${qi(p.name)}`,
          [qi(p.name), c.name],
        );
      }
      counts.push({ table: p.name, sqlite: total, postgres: 0 });
    }
    for (const p of plans) {
      for (const ix of p.indexes) {
        await tx.exec(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${qi(ix.name)} ON ${qi(p.name)} (${ix.cols.map(qi).join(", ")})`);
      }
    }
    // Foreign keys last. SQLite may hold rows that break them (its checks can be off): keep the rule for new rows and say so.
    let n = 0;
    for (const p of plans) {
      for (const fk of p.fks) {
        const parent = plans.find((x) => x.name === fk.table);
        const to = fk.to ?? parent?.pk ?? [];
        if (!parent || to.length !== fk.from.length) {
          warnings.push(`${env}: the reference from ${p.name}(${fk.from.join(", ")}) to ${fk.table} couldn't be copied.`);
          continue;
        }
        const name = qi(`${p.name}_${fk.from.join("_")}_fkey_${++n}`.slice(0, 63));
        const action = (a: string) => (/^(CASCADE|SET NULL|SET DEFAULT|RESTRICT)$/i.test(a) ? ` ${a.toUpperCase()}` : " NO ACTION");
        await tx.exec(
          `ALTER TABLE ${qi(p.name)} ADD CONSTRAINT ${name} FOREIGN KEY (${fk.from.map(qi).join(", ")}) REFERENCES ${qi(fk.table)} (${to.map(qi).join(", ")}) ON UPDATE${action(fk.onUpdate)} ON DELETE${action(fk.onDelete)} NOT VALID`,
        );
        await tx.exec("SAVEPOINT fk_check");
        try {
          await tx.exec(`ALTER TABLE ${qi(p.name)} VALIDATE CONSTRAINT ${name}`);
          await tx.exec("RELEASE SAVEPOINT fk_check");
        } catch {
          await tx.exec("ROLLBACK TO SAVEPOINT fk_check");
          warnings.push(`${env}: some ${p.name} rows point at ${fk.table} rows that don't exist; the reference applies to new rows only.`);
        }
      }
    }
  });
  for (const c of counts) c.postgres = Number((await pgdb.get<{ n: number }>(`SELECT count(*) AS n FROM ${qi(c.table)}`))?.n ?? -1);
  return counts;
}

const moving = new Set<string>();

export async function moveToPostgres(projectId: string): Promise<MoveReport> {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError("Cloud isn't enabled for this project.", 404);
  if ((await cloudEngine(projectId)) === "postgres") throw new CloudError("This project's database is already on PostgreSQL.", 409);
  if (projectId.includes("@")) throw new CloudError("Move the project, not one of its environments.");
  if (moving.has(projectId)) throw new CloudError("A move is already running for this project.", 409);
  try {
    await adminPool().query("SELECT 1");
  } catch (e) {
    throw new CloudError(`The PostgreSQL server can't be reached: ${e instanceof Error ? e.message : String(e)}`, 503);
  }
  moving.add(projectId);
  const warnings: string[] = [];
  const created: string[] = [];
  const envs: { env: "test" | "live"; dataId: string; file: string }[] = [{ env: "test", dataId: projectId, file: cloudDbFile(projectId) }];
  const liveFile = cloudDbFile(`${projectId}@live`);
  if (await fs.stat(liveFile).then(() => true, () => false)) envs.push({ env: "live", dataId: `${projectId}@live`, file: liveFile });
  const held: { release: (moved: boolean) => void; db: DatabaseSync }[] = [];
  let switched = false;
  try {
    for (const e of envs) held.push(await holdSqlite(e.file));
    if (held.length === 2) {
      // Live must already have every applied change, or the next publish would replay SQLite SQL on Postgres.
      const applied = (h: DatabaseSync) => new Set((h.prepare("SELECT id FROM _forge_migrations WHERE status = 'applied'").all() as { id: string }[]).map((r) => r.id));
      const live = applied(held[1].db);
      if ([...applied(held[0].db)].some((id) => !live.has(id))) {
        throw new CloudError("Live is missing database changes that Test has. Publish first, then move the database.", 409);
      }
    }
    const creds = cfg.pg ?? newPgCredentials(projectId);
    const password = openBox(PG_PURPOSE, creds.password);
    await ensureRole(creds.role, password);

    const report: MoveReport["environments"] = [];
    for (let i = 0; i < envs.length; i++) {
      const database = pgDatabaseName(envs[i].dataId);
      if (await databaseExists(database)) await dropDatabase(database); // left by an earlier attempt; the project still uses SQLite
      await createDatabase(database, creds.role);
      created.push(database);
      // The copy brings Forge's own tables (_forge_migrations, auth_users…): don't let the connection create them first.
      ensuredSet(database).add("__init");
      const counts = await copyInto(held[i].db, new PgDb({ database, user: creds.role, password }), warnings, envs[i].env);
      const wrong = counts.filter((c) => c.sqlite !== c.postgres);
      if (wrong.length) throw new CloudError(`Row counts don't match after copying: ${wrong.map((w) => `${w.table} ${w.sqlite} → ${w.postgres}`).join(", ")}. Nothing was changed.`);
      report.push({ env: envs[i].env, database, tables: counts });
      // That pool was opened with the move's own credentials object; the project's queries open their own.
      await closePgPool(database);
    }

    // Keep the SQLite data: a consistent copy in backups/, taken while nothing could write.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(cloudDir(projectId), "backups");
    await fs.mkdir(backupDir, { recursive: true });
    const sqliteBackups: string[] = [];
    for (let i = 0; i < envs.length; i++) {
      const file = path.join(backupDir, `${stamp}-${envs[i].env === "live" ? "live-" : ""}before-postgres.sqlite`);
      held[i].db.prepare("VACUUM INTO ?").run(file);
      sqliteBackups.push(path.relative(cloudDir(projectId), file).replace(/\\/g, "/"));
    }

    await updateCloud(projectId, (c) => {
      c.engine = "postgres";
      c.pg = creds;
      c.movedToPostgres = { at: new Date().toISOString(), sqliteBackups };
    });
    forgetEngine(projectId);
    switched = true;
    for (const h of held) h.release(true);
    held.length = 0;
    // The originals stay on disk under a new name, so nothing opens them by accident.
    for (const e of envs) {
      for (const ext of ["-wal", "-shm"]) await fs.rm(e.file + ext, { force: true }).catch(() => undefined);
      await fs.rename(e.file, `${e.file}.pre-postgres`).catch((err) => warnings.push(`The SQLite file ${path.basename(e.file)} couldn't be renamed (${err.message}); it is no longer used.`));
    }
    return { ok: true, environments: report, warnings, sqliteBackups };
  } catch (e) {
    if (!switched) for (const d of created) await dropDatabase(d).catch(() => undefined);
    throw e instanceof CloudError ? e : new CloudError(`The move failed and nothing was changed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const h of held) h.release(false);
    moving.delete(projectId);
  }
}
