import pg from "pg";
import type { CloudDb } from "./cloud-db";

/**
 * A plain SQL dump of a Cloud project's Postgres database (the public
 * schema): enum types, sequences, functions, tables, rows, constraints,
 * indexes, views, triggers and sequence positions, in an order that loads
 * into an empty database with psql or the SQL editor. Written here rather than
 * with pg_dump so it works without Postgres client tools on the host.
 * Run inside a READ ONLY transaction for a consistent snapshot.
 */

const qi = (n: string) => `"${n.replace(/"/g, '""')}"`;
const lit = (v: string) => pg.escapeLiteral(v);
type R = Record<string, unknown>;

export async function pgDump(db: CloudDb) {
  const out: string[] = [
    "-- PostgreSQL database dump (IOTx Cloud)",
    `-- Made ${new Date().toISOString()}. Load into an empty database: psql -d <database> -f this-file.sql`,
    "SET client_encoding = 'UTF8';",
    "SET standard_conforming_strings = on;",
    "SET check_function_bodies = false;",
    "",
  ];

  const enums = await db.all<{ name: string; labels: string[] }>(
    `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
     FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname`,
  );
  for (const e of enums) out.push(`CREATE TYPE ${qi(e.name)} AS ENUM (${e.labels.map(lit).join(", ")});`);

  // Sequences not owned by an identity column (serial columns and free ones).
  const seqs = await db.all<{ name: string; last: string | null; called: boolean }>(
    `SELECT s.sequencename AS name, s.last_value::text AS last, (s.last_value IS NOT NULL) AS called
     FROM pg_sequences s JOIN pg_class c ON c.relname = s.sequencename JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
     WHERE s.schemaname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i')
     ORDER BY 1`,
  );
  for (const s of seqs) out.push(`CREATE SEQUENCE ${qi(s.name)};`);

  const fns = await db.all<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') ORDER BY p.proname`,
  );
  for (const f of fns) out.push(`${f.def.trim()};`);
  out.push("");

  const tables = (await db.all<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).map((t) => t.name);
  for (const t of tables) {
    const cols = await db.all<{ name: string; type: string; notnull: boolean; dflt: string | null; identity: string; generated: string }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
         pg_get_expr(d.adbin, d.adrelid) AS dflt, a.attidentity AS identity, a.attgenerated AS generated
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relname = ? AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [t],
    );
    const defs = cols.map((c) => {
      let s = `  ${qi(c.name)} ${c.type}`;
      if (c.generated === "s" && c.dflt) s += ` GENERATED ALWAYS AS (${c.dflt}) STORED`;
      else if (c.identity) s += ` GENERATED ${c.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
      else if (c.dflt) s += ` DEFAULT ${c.dflt}`;
      if (c.notnull) s += " NOT NULL";
      return s;
    });
    out.push(`CREATE TABLE ${qi(t)} (\n${defs.join(",\n")}\n);`);

    // Rows: every value as its text form, which Postgres reads back into the column's type.
    const copyable = cols.filter((c) => c.generated !== "s");
    const rows = await db.all<R>(`SELECT ${copyable.map((c) => `${qi(c.name)}::text AS ${qi(c.name)}`).join(", ")} FROM ${qi(t)}`);
    const overriding = copyable.some((c) => c.identity === "a") ? " OVERRIDING SYSTEM VALUE" : "";
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      out.push(
        `INSERT INTO ${qi(t)} (${copyable.map((c) => qi(c.name)).join(", ")})${overriding} VALUES\n` +
          chunk.map((r) => `  (${copyable.map((c) => (r[c.name] === null ? "NULL" : lit(String(r[c.name])))).join(", ")})`).join(",\n") +
          ";",
      );
    }
    out.push("");
  }

  // Constraints after the rows (foreign keys last), then indexes that no constraint made.
  const cons = await db.all<{ tbl: string; name: string; def: string; type: string }>(
    `SELECT c.relname AS tbl, k.conname AS name, pg_get_constraintdef(k.oid) AS def, k.contype AS type
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND k.contype IN ('p', 'u', 'c', 'x', 'f')
     ORDER BY CASE k.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, c.relname, k.conname`,
  );
  for (const k of cons) out.push(`ALTER TABLE ONLY ${qi(k.tbl)} ADD CONSTRAINT ${qi(k.name)} ${k.def};`);
  const idx = await db.all<{ def: string }>(
    `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
     ORDER BY 1`,
  );
  for (const i of idx) out.push(`${i.def};`);

  const views = await db.all<{ name: string; def: string }>(
    `SELECT viewname AS name, definition AS def FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`,
  );
  for (const v of views) out.push(`CREATE VIEW ${qi(v.name)} AS\n${v.def.trim().replace(/;$/, "")};`);

  const triggers = await db.all<{ def: string }>(
    `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY t.tgname`,
  );
  for (const t of triggers) out.push(`${t.def};`);

  // Sequence positions: free/serial sequences, then identity columns.
  for (const s of seqs) if (s.last !== null) out.push(`SELECT setval(${lit(qi(s.name))}, ${Number(s.last)}, true);`);
  const ids = await db.all<{ tbl: string; col: string; last: string | null }>(
    `SELECT c.relname AS tbl, a.attname AS col, s.last_value::text AS last
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_sequences s ON s.schemaname = 'public' AND s.sequencename = split_part(pg_get_serial_sequence(quote_ident(c.relname), a.attname), '.', 2)
     WHERE n.nspname = 'public' AND a.attidentity <> '' AND c.relkind = 'r'`,
  );
  for (const i of ids) {
    if (i.last !== null) out.push(`SELECT setval(pg_get_serial_sequence(${lit(qi(i.tbl))}, ${lit(i.col)}), ${Number(i.last)}, true);`);
  }
  out.push("", "-- End of dump", "");
  return out.join("\n");
}
