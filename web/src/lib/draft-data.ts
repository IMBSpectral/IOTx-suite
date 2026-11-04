import { db } from "./db";
import { getBrand } from "./brand";
import { cloudEngine, draftDataId, draftDatabaseExists, getCloud, openDatabase, pgTarget, removeDraftDatabase } from "./cloud";
import { type Param } from "./cloud-db";
import { cloneDatabase, pgDatabaseName } from "./cloud-pg";
import { currentDraftId } from "./drafts";
import { sandboxState } from "./sandbox";
import { liveForOrigin, liveId } from "./cloud-envs";

/**
 * A draft's own backend: "This draft has its own backend, filled with example
 * data, so you can test changes separately from your live app." The draft's
 * database copies the live schema (never the live rows) and gets a few example
 * rows per table. The project's preview uses it while that draft is open;
 * the published app always uses the live data.
 */
const ROWS = 5;
const NAMES = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Linus Torvalds", "Margaret Hamilton"];
const WORDS = ["Sample", "Example", "Demo", "Test", "Preview"];

type Column = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
type ForeignKey = { table: string; from: string; to: string };

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;

function sampleValue(table: string, col: Column, i: number): unknown {
  const n = col.name.toLowerCase();
  const t = col.type.toUpperCase();
  const day = new Date(Date.now() - i * 86_400_000).toISOString();
  if (n === "id" && !t.includes("INT")) return crypto.randomUUID();
  // Postgres json/jsonb and array columns (format_type names are lowercase, so SQLite's declared types never match).
  if (/^jsonb?$/.test(col.type)) return JSON.stringify({ example: i + 1 });
  if (/\[\]$/.test(col.type)) return [];
  if (n.includes("email")) return `${NAMES[i % NAMES.length].split(" ")[0].toLowerCase()}${i + 1}@example.com`;
  if (/(^|_)(name|full_name|author|customer)$/.test(n)) return NAMES[i % NAMES.length];
  if (/(title|subject|label|headline)/.test(n)) return `${WORDS[i % WORDS.length]} ${table.replace(/s$/, "")} ${i + 1}`;
  if (/(description|body|content|notes?|message|summary|bio)/.test(n)) return `Example ${n.replace(/_/g, " ")} for testing this draft (${i + 1}).`;
  if (/(url|link|website)/.test(n)) return `https://example.com/${table}/${i + 1}`;
  if (/(image|photo|avatar|picture|thumbnail)/.test(n)) return `https://picsum.photos/seed/${table}${i + 1}/400/300`;
  if (/(_at|date|time)$/.test(n) || n.startsWith("date")) return day;
  if (/^(is|has|can)_|(active|enabled|done|completed|published)$/.test(n)) return i % 2;
  if (/(price|amount|total|cost|balance)/.test(n)) return Math.round((19.99 + i * 10) * 100) / 100;
  if (/(count|qty|quantity|stock|age|rating|score|position|order)/.test(n)) return i + 1;
  if (/status/.test(n)) return ["active", "pending", "done"][i % 3];
  if (/phone/.test(n)) return `+1 555 010${i}`;
  if (t.includes("INT")) return i + 1;
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUM")) return (i + 1) * 1.5;
  if (t.includes("BOOL")) return i % 2;
  return `${WORDS[i % WORDS.length]} ${n.replace(/_/g, " ")} ${i + 1}`;
}

/** Create (or recreate) a draft's database: the live schema, then example rows. */
export async function createDraftBackend(projectId: string, draftId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new Error(`This project doesn't use ${getBrand().shortName} Cloud, so drafts have nothing separate to test.`);
  await removeDraftDatabase(projectId, draftId);
  const live = openDatabase(projectId);
  const draft = openDatabase(draftDataId(projectId, draftId));
  let tables: string[];
  if ((await cloudEngine(projectId)) === "postgres") {
    // An exact copy of the project's schema (CREATE DATABASE … TEMPLATE), emptied: never the live rows.
    const t = await pgTarget(projectId);
    await cloneDatabase(t.database, pgDatabaseName(draftDataId(projectId, draftId)), t.user);
    const all = await draft.tables();
    if (all.length) await draft.exec(`TRUNCATE ${all.map(quote).join(", ")} RESTART IDENTITY CASCADE`);
    tables = all.filter((n) => !n.startsWith("_forge_") && n !== "auth_users");
  } else {
    const schema = await live.all<{ type: string; name: string; sql: string }>(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_forge_migrations', 'auth_users') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
    );
    for (const s of schema) await draft.exec(s.sql);
    tables = schema.filter((s) => s.type === "table" && !s.name.startsWith("_forge_")).map((s) => s.name);
  }
  // App sign-ups start empty: people sign up again in the draft, apart from live users.

  const fks = new Map<string, ForeignKey[]>();
  for (const t of tables) fks.set(t, await draft.foreignKeys(t));
  // Parents first, so foreign keys can point at rows that exist.
  const order: string[] = [];
  const visit = (t: string, seen = new Set<string>()) => {
    if (order.includes(t) || seen.has(t)) return;
    seen.add(t);
    for (const fk of fks.get(t) ?? []) if (fk.table !== t && tables.includes(fk.table)) visit(fk.table, seen);
    order.push(t);
  };
  tables.forEach((t) => visit(t));

  const seeded: Record<string, number> = {};
  for (const table of order) {
    const cols = (await draft.columns(table)) as Column[];
    const tableFks = fks.get(table) ?? [];
    let inserted = 0;
    for (let i = 0; i < ROWS; i++) {
      const row: Record<string, unknown> = {};
      for (const c of cols) {
        const auto = (c.pk && c.type.toUpperCase().includes("INT")) || c.dflt_value === "identity";
        if (auto) continue;
        const fk = tableFks.find((f) => f.from === c.name);
        if (fk) {
          const parent = await draft.get<{ v: unknown }>(`SELECT ${quote(fk.to || "rowid")} AS v FROM ${quote(fk.table)} LIMIT 1 OFFSET ${i % ROWS}`);
          if (parent) row[c.name] = parent.v;
          else if (c.notnull) continue;
          continue;
        }
        if (c.dflt_value !== null && !c.notnull) continue;
        row[c.name] = sampleValue(table, c, i);
      }
      const names = Object.keys(row);
      try {
        await draft.run(
          names.length ? `INSERT INTO ${quote(table)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})` : `INSERT INTO ${quote(table)} DEFAULT VALUES`,
          Object.values(row) as Param[],
        );
        inserted++;
      } catch {
        // A CHECK or UNIQUE rule this simple generator can't satisfy: fewer example rows.
      }
    }
    seeded[table] = inserted;
  }
  await db.draft.update({ where: { id: draftId }, data: { ownBackend: true } });
  return { tables: seeded };
}

export async function removeDraftBackend(projectId: string, draftId: string) {
  await removeDraftDatabase(projectId, draftId);
  await db.draft.update({ where: { id: draftId }, data: { ownBackend: false } }).catch(() => undefined);
}

/**
 * Which data a Cloud request should use: the open draft's own database when
 * the request comes from the project's live preview and that draft has one,
 * otherwise the live data.
 */
export async function dataScope(projectId: string, origin: string | null) {
  if (!origin) return projectId;
  // The published site and custom domain use the Live environment once it exists.
  if (await liveForOrigin(projectId, origin)) return liveId(projectId);
  const s = sandboxState(projectId);
  if (s.status !== "ready") return projectId;
  const fromPreview = origin === `http://127.0.0.1:${s.port}` || origin === `http://localhost:${s.port}`;
  if (!fromPreview) return projectId;
  const draftId = await currentDraftId(projectId);
  if (!draftId) return projectId;
  const d = await db.draft.findUnique({ where: { id: draftId }, select: { ownBackend: true } });
  if (!d?.ownBackend || !(await draftDatabaseExists(projectId, draftId))) return projectId;
  return draftDataId(projectId, draftId);
}
