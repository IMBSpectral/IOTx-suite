/**
 * Insights engine: one DuckDB database per analysis.
 *
 * - Locked down: no file access outside the analysis's own folder, no settings
 *   changes, and SQL from the AI or a chart must be a single SELECT (checked by
 *   DuckDB's own parser), with a time limit.
 * - Cross-filtering: a chart's SQL runs with each filtered table replaced by a
 *   filtered copy of itself (a CTE with the table's name), so a click on
 *   "Department = HR" narrows every chart built on any table with that column.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { promises as fs } from "node:fs";
import path from "node:path";
import { analysisDir, dbFile, InsightsError, type Analysis, type Table } from "./store";

type Handle = { inst: DuckDBInstance; conn: DuckDBConnection; used: number; queue: Promise<unknown> };
// One cache for the whole server process: Next can load this module once per route, and two
// DuckDB instances on one file conflict (Windows refuses the second; elsewhere they would diverge).
const G = globalThis as unknown as { __insightsDuck?: Map<string, Handle>; __insightsOpening?: Map<string, Promise<Handle>> };
const open = (G.__insightsDuck ??= new Map<string, Handle>());
const opening = (G.__insightsOpening ??= new Map<string, Promise<Handle>>());
const MAX_OPEN = 4;

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const slash = (p: string) => p.split(path.sep).join("/");

async function handle(a: Pick<Analysis, "workspaceId" | "id">): Promise<Handle> {
  const key = `${a.workspaceId}/${a.id}`;
  const h = open.get(key);
  if (h) {
    h.used = Date.now();
    return h;
  }
  // Requests arriving together share one opening of the file.
  const pending = opening.get(key);
  if (pending) return pending;
  const p = (async () => {
    if (open.size >= MAX_OPEN) {
      const oldest = [...open.entries()].sort((x, y) => x[1].used - y[1].used)[0];
      open.delete(oldest[0]);
      await oldest[1].queue.catch(() => {});
      oldest[1].conn.closeSync();
      oldest[1].inst.closeSync();
    }
    await fs.mkdir(analysisDir(a.workspaceId, a.id), { recursive: true });
    const inst = await DuckDBInstance.create(dbFile(a), { memory_limit: "768MB", threads: "2" });
    const conn = await inst.connect();
    await conn.run(`SET allowed_directories=[${lit(slash(analysisDir(a.workspaceId, a.id)))}]`);
    await conn.run("SET enable_external_access=false");
    await conn.run("SET lock_configuration=true");
    const made: Handle = { inst, conn, used: Date.now(), queue: Promise.resolve() };
    open.set(key, made);
    return made;
  })();
  opening.set(key, p);
  try {
    return await p;
  } finally {
    opening.delete(key);
  }
}

/** Run on the analysis's connection, one statement at a time. */
async function onConn<T>(a: Pick<Analysis, "workspaceId" | "id">, fn: (c: DuckDBConnection) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const h = await handle(a);
  const run = h.queue.catch(() => {}).then(async () => {
    const timer = setTimeout(() => h.conn.interrupt(), timeoutMs);
    try {
      return await fn(h.conn);
    } finally {
      clearTimeout(timer);
    }
  });
  h.queue = run;
  return run;
}

export async function closeAnalysis(a: Pick<Analysis, "workspaceId" | "id">) {
  const key = `${a.workspaceId}/${a.id}`;
  const h = open.get(key);
  if (!h) return;
  open.delete(key);
  await h.queue.catch(() => {});
  h.conn.closeSync();
  h.inst.closeSync();
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL.*)$/i;

export type Result = { columns: { name: string; type: string }[]; rows: unknown[][]; truncated?: boolean };

function toResult(r: { columnNames(): string[]; columnTypes(): { toString(): string }[]; getRowsJson(): unknown[][] }, limit: number): Result {
  const columns = r.columnNames().map((name, i) => ({ name, type: r.columnTypes()[i].toString() }));
  const all = r.getRowsJson();
  const rows = all.slice(0, limit).map((row) =>
    row.map((v, i) => (NUMERIC.test(columns[i].type) && typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : v)),
  );
  return { columns, rows, truncated: all.length > limit };
}

/** Throws unless sql is exactly one SELECT (WITH, SUMMARIZE and DESCRIBE count). */
async function assertSelect(c: DuckDBConnection, sql: string) {
  const r = await c.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)", [sql]);
  const j = JSON.parse(String(r.getRows()[0][0])) as { error?: boolean; error_message?: string; statements?: unknown[] };
  if (j.error) throw new InsightsError(/Only SELECT/i.test(j.error_message ?? "") ? "Only questions about the data (SELECT) can run here." : (j.error_message ?? "That SQL couldn't be read."));
  if ((j.statements?.length ?? 0) !== 1) throw new InsightsError("Run one query at a time.");
}

export type Filter = { column: string; table?: string; values?: (string | number | null)[]; from?: string | number; to?: string | number };

/** Each table with a filtered column, as a filtered copy of itself. */
function filterCtes(tables: Table[], filters: Filter[]) {
  const ctes: string[] = [];
  for (const t of tables) {
    const conds: string[] = [];
    for (const f of filters) {
      if (f.table && f.table !== t.name) continue;
      const col = t.columns.find((c) => c.name.toLowerCase() === f.column.toLowerCase());
      if (!col) continue;
      const c = q(col.name);
      if (f.values?.length) {
        const nonNull = f.values.filter((v) => v !== null && v !== "");
        const parts = [nonNull.length ? `CAST(${c} AS VARCHAR) IN (${nonNull.map((v) => lit(String(v))).join(", ")})` : "", f.values.length > nonNull.length ? `${c} IS NULL` : ""].filter(Boolean);
        conds.push(`(${parts.join(" OR ")})`);
      }
      const num = NUMERIC.test(col.type);
      const val = (v: string | number) => (num && Number.isFinite(Number(v)) ? String(Number(v)) : lit(String(v)));
      const cast = num ? c : /DATE|TIME/i.test(col.type) ? c : `CAST(${c} AS VARCHAR)`;
      if (f.from !== undefined && f.from !== "") conds.push(`${cast} >= ${/DATE|TIME/i.test(col.type) ? `CAST(${lit(String(f.from))} AS ${col.type})` : val(f.from)}`);
      if (f.to !== undefined && f.to !== "") conds.push(`${cast} <= ${/DATE|TIME/i.test(col.type) ? `CAST(${lit(String(f.to))} AS ${col.type})` : val(f.to)}`);
    }
    if (conds.length) ctes.push(`${q(t.name)} AS (SELECT * FROM main.${q(t.name)} WHERE ${conds.join(" AND ")})`);
  }
  return ctes;
}

/** Prefix filter CTEs to a query (merging with its own WITH when it has one). */
function withFilters(sql: string, ctes: string[]) {
  if (!ctes.length) return sql;
  const body = sql.trim().replace(/;+\s*$/, "");
  const m = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(body);
  if (m) return `WITH ${m[1] ?? ""}${ctes.join(", ")}, ${body.slice(m[0].length)}`;
  return `WITH ${ctes.join(", ")} ${body}`;
}

/** A read-only query, as the AI or a chart asks it, with filters applied. */
export async function query(a: Analysis, sql: string, o: { limit?: number; filters?: Filter[]; timeoutMs?: number } = {}): Promise<Result> {
  const limit = Math.min(o.limit ?? 5000, 50_000);
  return onConn(
    a,
    async (c) => {
      await assertSelect(c, sql);
      const full = withFilters(sql, filterCtes(a.tables, o.filters ?? []));
      try {
        return toResult(await c.runAndReadAll(full), limit);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/interrupt/i.test(msg)) throw new InsightsError("That query took too long (over 30 seconds). Narrow it down.");
        throw new InsightsError(msg.replace(/\n+/g, " ").slice(0, 600));
      }
    },
    o.timeoutMs,
  );
}

/** A table name that's free in this analysis. */
export function freeName(a: Analysis, want: string) {
  const base = want.replace(/\s+/g, " ").replace(/["\x00-\x1f]/g, "").trim().slice(0, 60) || "Table";
  const taken = new Set(a.tables.map((t) => t.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
  return name;
}

/** Unique, non-empty column names from a heading row. */
export function cleanHeadings(head: string[], width: number) {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    let h = (head[i] ?? "").replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 80) || `Column ${i + 1}`;
    const n = seen.get(h.toLowerCase()) ?? 0;
    seen.set(h.toLowerCase(), n + 1);
    if (n) h = `${h} (${n + 1})`;
    return h;
  });
}

/**
 * Load rows of text as a typed table: everything goes in as text, then each column
 * becomes a number, date, timestamp or yes/no when every value it has reads as one.
 */
export async function loadRows(a: Analysis, name: string, headings: string[], rows: string[][]): Promise<Table["columns"]> {
  return onConn(
    a,
    async (c) => {
      const raw = `__raw_${Date.now()}`;
      await c.run(`CREATE OR REPLACE TABLE ${q(raw)} (${headings.map((h) => `${q(h)} VARCHAR`).join(", ")})`);
      const app = await c.createAppender(raw);
      for (const r of rows) {
        for (let i = 0; i < headings.length; i++) {
          const v = r[i];
          if (v === undefined || v === "") app.appendNull();
          else app.appendVarchar(v);
        }
        app.endRow();
      }
      app.closeSync();
      const exprs: string[] = [];
      for (const h of headings) {
        const col = q(h);
        // Numbers may carry thousands separators, currency signs or a % sign.
        const numText = `regexp_replace(trim(${col}), '^[₹$€£]\\s*|,|\\s*%$', '', 'g')`;
        const probe = await c.runAndReadAll(
          `SELECT count(${col}) n,
                  count(TRY_CAST(${numText} AS DOUBLE)) num,
                  count(*) FILTER (WHERE trim(${col}) LIKE '%\\%' ESCAPE '\\') pct,
                  count(TRY_CAST(${col} AS DATE)) d,
                  count(TRY_CAST(${col} AS TIMESTAMP)) ts,
                  count(*) FILTER (WHERE regexp_matches(trim(${col}), '^\\d{1,2}:\\d{2}(:\\d{2})?$') AND TRY_CAST(trim(${col}) AS TIME) IS NOT NULL) tm,
                  count(*) FILTER (WHERE lower(trim(${col})) IN ('true','false','yes','no')) b,
                  count(*) FILTER (WHERE TRY_CAST(${numText} AS DOUBLE) IS NOT NULL AND ${numText} LIKE '%.%') dec
           FROM ${q(raw)}`,
        );
        const [n, num, pct, d, ts, tm, b, dec] = probe.getRows()[0].map(Number);
        if (!n) exprs.push(`${col}`);
        else if (tm === n) exprs.push(`TRY_CAST(trim(${col}) AS TIME) AS ${col}`);
        else if (num === n && pct === n) exprs.push(`TRY_CAST(${numText} AS DOUBLE) / 100 AS ${col}`);
        else if (num === n) exprs.push(`TRY_CAST(${numText} AS ${dec ? "DOUBLE" : "BIGINT"}) AS ${col}`);
        else if (d === n) exprs.push(`TRY_CAST(${col} AS DATE) AS ${col}`);
        else if (ts === n) exprs.push(`TRY_CAST(${col} AS TIMESTAMP) AS ${col}`);
        else if (b === n) exprs.push(`lower(trim(${col})) IN ('true','yes') AS ${col}`);
        else exprs.push(`${col}`);
      }
      await c.run(`CREATE OR REPLACE TABLE ${q(name)} AS SELECT ${exprs.join(", ")} FROM ${q(raw)}`);
      await c.run(`DROP TABLE ${q(raw)}`);
      return describe(c, name);
    },
    120_000,
  );
}

async function describe(c: DuckDBConnection, name: string) {
  const r = await c.runAndReadAll(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [name]);
  return r.getRows().map(([n, t]) => ({ name: String(n), type: String(t) }));
}

/** Load a CSV/TSV, JSON or Parquet file kept in the analysis's folder. */
export async function loadFile(a: Analysis, name: string, file: string, kind: "csv" | "json" | "parquet"): Promise<Table["columns"]> {
  const f = lit(slash(file));
  const reader = kind === "csv" ? `read_csv(${f}, header = true, sample_size = -1)` : kind === "json" ? `read_json_auto(${f})` : `read_parquet(${f})`;
  return onConn(
    a,
    async (c) => {
      await c.run(`CREATE OR REPLACE TABLE ${q(name)} AS SELECT * FROM ${reader}`);
      return describe(c, name);
    },
    120_000,
  );
}

export async function rowCount(a: Analysis, name: string) {
  return onConn(a, async (c) => Number((await c.runAndReadAll(`SELECT count(*) FROM ${q(name)}`)).getRows()[0][0]));
}

export async function dropTable(a: Analysis, name: string) {
  await onConn(a, (c) => c.run(`DROP TABLE IF EXISTS ${q(name)}`));
}

/** A new table from a SELECT over existing tables (a cleaned or joined view of the data). */
export async function tableFromQuery(a: Analysis, name: string, sql: string): Promise<Table["columns"]> {
  return onConn(
    a,
    async (c) => {
      await assertSelect(c, sql);
      await c.run(`CREATE OR REPLACE TABLE ${q(name)} AS ${sql.trim().replace(/;+\s*$/, "")}`);
      return describe(c, name);
    },
    60_000,
  );
}

/**
 * Each table at a glance for the AI: every column's type, how full it is, its range or
 * most common values, plus the first rows. Small tables come whole.
 */
export async function profile(a: Analysis, o: { table?: string; sampleRows?: number; wholeUnder?: number; budget?: number } = {}) {
  const parts: string[] = [];
  let used = 0;
  // Visible sheets first: hidden ones are often helpers, templates or old copies.
  const tables = a.tables.filter((x) => !o.table || x.name === o.table).sort((x, y) => Number(/(hidden)/.test(x.part ?? "")) - Number(/(hidden)/.test(y.part ?? "")));
  for (const [ti, t] of tables.entries()) {
    if (o.budget && used > o.budget) {
      parts.push(`### Not profiled here (ask profile_table): ${tables.slice(ti).map((x) => `${q(x.name)} (${x.rows} rows: ${x.columns.slice(0, 12).map((c) => q(c.name)).join(", ")}${x.columns.length > 12 ? ", …" : ""})`).join("; ")}`);
      break;
    }
    const lines = [`### Table ${q(t.name)}: ${t.rows} rows, ${t.columns.length} columns (from ${t.source}${t.part ? `, ${t.part}` : ""})${t.title ? `\nTitle: ${t.title}` : ""}`];
    try {
      const s = await query(a, `SUMMARIZE ${q(t.name)}`, { limit: 500 });
      const idx = (n: string) => s.columns.findIndex((c) => c.name === n);
      for (const r of s.rows) {
        const [name, type, min, max, uniq, avg, , , q50, , , nulls] = [0, 1, 2, 3, 4, 5, 6, 7, idx("q50"), 9, 10, idx("null_percentage")].map((i) => r[i]);
        const num = NUMERIC.test(String(type));
        let detail = num
          ? `min ${min}, median ${q50}, avg ${typeof avg === "number" ? +avg.toFixed(4) : avg}, max ${max}`
          : /DATE|TIME/i.test(String(type))
            ? `${min} to ${max}`
            : `~${uniq} distinct`;
        if (!num && !/DATE|TIME/i.test(String(type)) && Number(uniq) <= 40) {
          const top = await query(a, `SELECT ${q(String(name))} v, count(*) n FROM ${q(t.name)} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, { limit: 12 });
          detail += `: ${top.rows.map((x) => `${x[0] ?? "(blank)"} (${x[1]})`).join(", ")}`;
        }
        lines.push(`- ${q(String(name))} ${type}: ${detail}${Number(String(nulls).replace("%", "")) > 0 ? `; ${nulls}% blank` : ""}`);
      }
    } catch {
      lines.push(...t.columns.map((c) => `- ${q(c.name)} ${c.type}`));
    }
    const whole = t.rows <= (o.wholeUnder ?? 0);
    const sample = await query(a, `SELECT * FROM ${q(t.name)} LIMIT ${whole ? t.rows : (o.sampleRows ?? 5)}`, { limit: 1000 }).catch(() => null);
    if (sample?.rows.length) {
      lines.push(whole ? "All rows:" : `First ${sample.rows.length} rows:`);
      lines.push(sample.columns.map((c) => c.name).join("\t"));
      for (const r of sample.rows) lines.push(r.map((v) => (v === null ? "" : String(v).slice(0, 60))).join("\t"));
    }
    const text = lines.join("\n");
    parts.push(text);
    used += text.length;
  }
  return parts.join("\n\n");
}

/** Columns that appear (same name, overlapping values) in more than one table: how sheets join. */
export async function links(a: Analysis) {
  const byName = new Map<string, Table[]>();
  for (const t of a.tables) for (const c of t.columns) byName.set(c.name.toLowerCase(), [...(byName.get(c.name.toLowerCase()) ?? []), t]);
  const out: string[] = [];
  for (const [col, ts] of byName) {
    if (ts.length < 2 || out.length >= 40) continue;
    // Keys are ids, codes and names: not measures, times or yes/no.
    const type = ts[0].columns.find((c) => c.name.toLowerCase() === col)!.type;
    if (/DOUBLE|FLOAT|DECIMAL|TIME|BOOLEAN/i.test(type)) continue;
    const names = ts.map((t) => ({ t, c: t.columns.find((c) => c.name.toLowerCase() === col)!.name }));
    const [x, y] = names;
    const r = await query(
      a,
      `SELECT count(DISTINCT a.v) FROM (SELECT CAST(${q(x.c)} AS VARCHAR) v FROM ${q(x.t.name)}) a JOIN (SELECT CAST(${q(y.c)} AS VARCHAR) v FROM ${q(y.t.name)}) b USING (v)`,
      { limit: 1 },
    ).catch(() => null);
    const shared = Number(r?.rows[0]?.[0] ?? 0);
    if (shared >= 3)
      out.push(`- ${q(x.c)} links ${names.slice(0, 6).map((n) => q(n.t.name)).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""} (${shared} shared values between the first two)`);
  }
  return out.join("\n");
}
