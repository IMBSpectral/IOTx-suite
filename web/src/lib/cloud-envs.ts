import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { cloudDbFile, cloudEngine, dataExists, getCloud, openDatabase, pgTarget, pgValue, type Migration } from "./cloud";
import type { CloudDb, Param } from "./cloud-db";
import { withSqlite } from "./cloud-db";
import { cloneDatabase, pgDatabaseName } from "./cloud-pg";
import { SITES_HOST } from "./site-host";

/**
 * Test and Live environments for a Forge Cloud backend. Until the first
 * publish there is one database, Test. The first publish creates Live as a
 * copy of Test (schema and data); after that the published site and custom
 * domain use Live while the preview and drafts keep using Test, and each
 * publish applies to Live the database changes it hasn't had yet. Storage,
 * server functions, secrets and access rules are shared by both.
 *
 * SQLite: Live is a second file, first made with VACUUM INTO. Postgres: Live
 * is a second database (fc_<project>_live), first made with CREATE DATABASE
 * … TEMPLATE (an exact copy, sequences included). Later publishes replay the
 * migrations Live hasn't had, each in its own transaction, on both engines.
 */

export const liveId = (projectId: string) => `${projectId.split("@")[0]}@live`;

// Live, once made, stays: remember it so requests from the published site don't each ask the database server.
const gl = globalThis as unknown as { __forgeCloudLive?: Set<string> };
const knownLive = (gl.__forgeCloudLive ??= new Set<string>());

export async function hasLive(projectId: string) {
  const id = liveId(projectId);
  if (knownLive.has(id)) return true;
  const yes = await dataExists(id);
  if (yes) knownLive.add(id);
  return yes;
}

/** Forget that Live exists (the backend was turned off or moved to another engine). */
export function forgetLive(projectId: string) {
  knownLive.delete(liveId(projectId));
}

/** The data id for an environment name from the Cloud tab. */
export async function envDataId(projectId: string, env: string | null) {
  return env === "live" && (await hasLive(projectId)) ? liveId(projectId) : projectId;
}

/**
 * Called after a publish: create Live from Test the first time, otherwise
 * bring Live's schema up to date. Returns what happened, for the publish log.
 */
export async function syncLive(projectId: string): Promise<{ created: boolean; applied: string[]; failed: { id: string; error: string }[] }> {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) return { created: false, applied: [], failed: [] };
  if (!(await hasLive(projectId))) {
    if ((await cloudEngine(projectId)) === "postgres") {
      // An exact copy of Test's database, owned by the project's role.
      const t = await pgTarget(projectId);
      await cloneDatabase(t.database, pgDatabaseName(liveId(projectId)), t.user);
    } else {
      const target = cloudDbFile(liveId(projectId));
      await fs.mkdir(path.dirname(target), { recursive: true });
      // A consistent copy of Test, schema and data, migration history included.
      await withSqlite(cloudDbFile(projectId), (h) => h.prepare("VACUUM INTO ?").run(target));
    }
    return { created: true, applied: [], failed: [] };
  }
  const test = openDatabase(projectId);
  const live = openDatabase(liveId(projectId));
  const done = new Set((await live.all<{ id: string }>("SELECT id FROM _forge_migrations WHERE status = 'applied'")).map((r) => r.id));
  const todo = (await test.all<Migration>("SELECT * FROM _forge_migrations WHERE status = 'applied' ORDER BY applied_at ASC")).filter((m) => !done.has(m.id));
  const applied: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const m of todo) {
    try {
      await live.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.run(
          `INSERT INTO _forge_migrations (id, description, sql, status, created_at, applied_at) VALUES (?, ?, ?, 'applied', ?, ?)
           ON CONFLICT (id) DO UPDATE SET status = 'applied', applied_at = excluded.applied_at, error = NULL`,
          [m.id, m.description, m.sql, m.created_at, new Date().toISOString()],
        );
      });
      applied.push(m.description);
    } catch (e) {
      failed.push({ id: m.id, error: e instanceof Error ? e.message : String(e) });
      // Later changes may depend on this one, so stop here.
      break;
    }
  }
  return { created: false, applied, failed };
}

/** Which environment a request to the app's API belongs to: the live site and custom domain use Live. */
export async function liveForOrigin(projectId: string, origin: string | null) {
  if (!origin || !(await hasLive(projectId))) return false;
  const p = await db.project.findUnique({ where: { id: projectId }, select: { subdomain: true, customDomain: true } });
  if (!p) return false;
  const host = SITES_HOST;
  try {
    const o = new URL(origin);
    return o.host === `${p.subdomain}.${host}` || (!!p.customDomain && o.host === p.customDomain);
  } catch {
    return false;
  }
}

// ── Records: Test → Live ──────────────────────────────────────────────────

export type RecordsCopied = { tables: { table: string; rows: number }[]; skipped: { table: string; reason: string }[] };

/** Rows a table may hold before it is left out of the copy (a bulk table is data, not setup). */
const COPY_LIMIT = 20_000;
/** Bookkeeping tables (logs, runs, codes, migrations) stay per environment. Accounts (auth_users) are copied. */
const NOT_COPIED = /^(_forge_|sqlite_)/;
const quoteName = (n: string) => `"${n.replace(/"/g, '""')}"`;

/**
 * Called after a publish: copy into Live the records and accounts made in Test (the preview)
 * that Live doesn't have yet — an admin login, roles, lookup lists, sample rows.
 *
 * Only ever adds. A row already in Live (same key) is left as Live has it, so nothing the live
 * app's users did is overwritten or deleted. Each copied row is remembered in Live, so a record
 * someone later deletes on the live site isn't brought back by the next publish. Tables keyed by
 * a number are skipped: Test's row 5 and Live's row 5 are unrelated records, so copying by number
 * would attach rows to the wrong parent.
 */
export async function copyNewRecords(projectId: string): Promise<RecordsCopied> {
  const out: RecordsCopied = { tables: [], skipped: [] };
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled || !(await hasLive(projectId))) return out;
  const test = openDatabase(projectId);
  const live = openDatabase(liveId(projectId));
  const pg = (await live.engine()) === "postgres";
  await live.ensure(`CREATE TABLE IF NOT EXISTS _forge_copied (tbl TEXT NOT NULL, pk TEXT NOT NULL, copied_at TEXT NOT NULL, PRIMARY KEY (tbl, pk))`);

  const liveTables = new Set(await live.tables());
  type Plan = { table: string; cols: string[]; types: Map<string, string>; keys: string[]; parents: string[] };
  const plans: Plan[] = [];
  for (const table of await test.tables()) {
    if (NOT_COPIED.test(table) || !liveTables.has(table)) continue;
    const [tc, lc] = await Promise.all([test.columns(table), live.columns(table)]);
    const lnames = new Set(lc.map((c) => c.name));
    const cols = tc.filter((c) => lnames.has(c.name));
    const keys = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const numbered = keys.length === 1 && /int|serial|number|numeric/i.test(keys[0].type);
    if (!keys.length || numbered) {
      // Said only when the preview holds more rows than the live app, i.e. something is being left behind.
      const n = async (d: CloudDb) => Number((await d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoteName(table)}`))?.n ?? 0);
      if ((await n(test)) > (await n(live))) {
        out.skipped.push({
          table,
          reason: numbered ? "its rows are numbered, and the preview's numbers don't match the live app's" : "it has no key, so copied rows couldn't be told apart",
        });
      }
      continue;
    }
    const fks = await test.foreignKeys(table).catch(() => []);
    plans.push({
      table,
      cols: cols.map((c) => c.name),
      types: new Map(cols.map((c) => [c.name, c.type])),
      keys: keys.map((c) => c.name),
      parents: [...new Set(fks.map((f) => f.table).filter((t) => t !== table))],
    });
  }
  // Parents before children, so a copied row's foreign keys find their target.
  const order: Plan[] = [];
  const placed = new Set<string>();
  const byName = new Map(plans.map((p) => [p.table, p]));
  const visit = (p: Plan, seen: Set<string>) => {
    if (placed.has(p.table) || seen.has(p.table)) return;
    seen.add(p.table);
    for (const parent of p.parents) {
      const pp = byName.get(parent);
      if (pp) visit(pp, seen);
    }
    placed.add(p.table);
    order.push(p);
  };
  for (const p of plans) visit(p, new Set());

  const value = (v: unknown, type: string): Param => {
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Uint8Array) return v;
    if (!pg) return v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "object" && v !== null ? JSON.stringify(v) : (v as Param);
    return pgValue(v, type);
  };
  const keyOf = (row: Record<string, unknown>, keys: string[]) => JSON.stringify(keys.map((k) => String(row[k] ?? "")));
  const now = new Date().toISOString();

  for (const p of order) {
    const t = quoteName(p.table);
    const count = (await test.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))?.n ?? 0;
    if (!count) continue;
    if (Number(count) > COPY_LIMIT) {
      out.skipped.push({ table: p.table, reason: `it has ${count} rows in Test; tables over ${COPY_LIMIT.toLocaleString()} aren't copied` });
      continue;
    }
    const keyList = p.keys.map(quoteName).join(", ");
    const [rows, inLive, done] = await Promise.all([
      test.all<Record<string, unknown>>(`SELECT ${p.cols.map(quoteName).join(", ")} FROM ${t}`),
      live.all<Record<string, unknown>>(`SELECT ${keyList} FROM ${t}`),
      live.all<{ pk: string }>(`SELECT pk FROM _forge_copied WHERE tbl = ?`, [p.table]),
    ]);
    const skip = new Set([...inLive.map((r) => keyOf(r, p.keys)), ...done.map((r) => r.pk)]);
    const todo = rows.filter((r) => !skip.has(keyOf(r, p.keys)));
    if (!todo.length) continue;
    const insert = `INSERT INTO ${t} (${p.cols.map(quoteName).join(", ")}) VALUES (${p.cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`;
    let n = 0;
    await live.transaction(async (tx: CloudDb) => {
      for (const r of todo) {
        const res = await tx.run(insert, p.cols.map((c) => value(r[c], p.types.get(c) ?? "")));
        await tx.run(`INSERT INTO _forge_copied (tbl, pk, copied_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [p.table, keyOf(r, p.keys), now]);
        n += res.changes > 0 ? 1 : 0;
      }
    }).catch((e) => {
      out.skipped.push({ table: p.table, reason: `the copy failed and changed nothing: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
      n = -1;
    });
    if (n > 0) out.tables.push({ table: p.table, rows: n });
  }
  return out;
}
