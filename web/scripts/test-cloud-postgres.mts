/**
 * Cloud on PostgreSQL: "Move to PostgreSQL" (schema + data for Test and Live,
 * row counts checked, SQLite kept as backups), the REST API and access rules
 * on Postgres, per-project isolation (own database + own role), SQL that
 * reaches outside the project refused, Test/Live (migration replay), a
 * draft's own database, backups/restore, the SQL export loading into an empty
 * database, and clean removal of every database and the role.
 * Works with the server on either default engine (projects start on SQLite and are moved).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cloud-postgres.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
void users;
const cookie = `authjs.session-token=${token}`;
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const lib = await import("../src/lib/cloud");
const pgLib = await import("../src/lib/cloud-pg");
const { syncLive } = await import("../src/lib/cloud-envs");
const { createDraft } = await import("../src/lib/drafts");
const { createDraftBackend, removeDraftBackend } = await import("../src/lib/draft-data");

async function newProject(name: string) {
  const pid = ((await call("/api/projects", { name, force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  return { pid, anonKey };
}
function app(pid: string, anonKey: string) {
  return async (p: string, init: { method?: string; body?: unknown; bearer?: string; origin?: string } = {}) => {
    const r = await fetch(`${BASE}/cloud/v1/${pid}${p}`, {
      method: init.method ?? "GET",
      headers: {
        apikey: anonKey,
        "user-agent": UA,
        "content-type": "application/json",
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
}
async function asRole(pid: string, database: string) {
  const t = await lib.pgTarget(pid);
  const u = new URL(pgLib.pgAdminUrl());
  u.username = t.user;
  u.password = t.password;
  u.pathname = `/${database}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}
const fails = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const ids: string[] = [];
let role1 = "";
try {
  // ── A SQLite project with data, sign-ins, an owner rule and a Live copy ──
  const { pid, anonKey } = await newProject("PG move test");
  ids.push(pid);
  const A = `/api/projects/${pid}/cloud/admin`;
  const api = app(pid, anonKey);
  check("a new project starts on SQLite (default engine)", (await call(`${A}?view=settings`)).json.engine === "sqlite" || process.env.FORGE_CLOUD_ENGINE === "postgres");
  const mig = await lib.proposeMigration(
    pid,
    "notes and items",
    `CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN DEFAULT 0, price NUMERIC, created_at TEXT DEFAULT CURRENT_TIMESTAMP, user_id TEXT);
     CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT REFERENCES notes(id) ON DELETE CASCADE, qty REAL NOT NULL DEFAULT 1, tag TEXT UNIQUE);
     CREATE INDEX idx_items_note ON items (note_id);`,
  );
  await lib.applyMigration(pid, mig);
  const ana = (await api("/auth/signup", { method: "POST", body: { email: "ana@example.com", password: "password123" } })).json.token as string;
  const bo = (await api("/auth/signup", { method: "POST", body: { email: "bo@example.com", password: "password123" } })).json.token as string;
  await call(`/api/projects/${pid}/cloud`, { action: "policy", table: "notes", read: "owner", write: "owner" });
  const made = await api("/rest/notes", { method: "POST", bearer: ana, body: [{ title: "Ana's first", price: 9.5 }, { title: "Ana's second", done: true }] });
  await api("/rest/notes", { method: "POST", bearer: bo, body: { title: "Bo's" } });
  const noteId = made.json[0].id as string;
  await api("/rest/items", { method: "POST", bearer: ana, body: [{ note_id: noteId, qty: 2, tag: "a" }, { note_id: noteId, qty: 3.5, tag: "b" }] });
  await lib.closeDatabase(pid);
  const live = await syncLive(pid);
  await lib.closeDatabase(pid);
  await lib.closeDatabase(`${pid}@live`);
  check("Live is made (SQLite) before the move", live.created);

  // ── Move ──
  const moved = await call(A, { action: "moveToPostgres" });
  const report = moved.json as { environments: { env: string; database: string; tables: { table: string; sqlite: number; postgres: number }[] }[]; warnings: string[]; sqliteBackups: string[] };
  check("Move to PostgreSQL succeeds", moved.status === 200, JSON.stringify(moved.json).slice(0, 400));
  const envs = report.environments ?? [];
  check("both Test and Live are moved", envs.map((e) => e.env).join(",") === "test,live", envs.map((e) => e.env).join(","));
  const testCounts = Object.fromEntries((envs[0]?.tables ?? []).map((t) => [t.table, t]));
  check(
    "row counts match per table",
    envs.every((e) => e.tables.every((t) => t.sqlite === t.postgres)) && testCounts.notes?.postgres === 3 && testCounts.items?.postgres === 2 && testCounts.auth_users?.postgres === 2,
    JSON.stringify(envs[0]?.tables),
  );
  const backupFiles = await Promise.all((report.sqliteBackups ?? []).map((b) => fs.stat(path.join(lib.cloudDir(pid), b)).then(() => true, () => false)));
  check("the SQLite data is kept as backups", backupFiles.length === 2 && backupFiles.every(Boolean), JSON.stringify(report.sqliteBackups));
  check("the original SQLite file is set aside", await fs.stat(path.join(lib.cloudDir(pid), "data.sqlite.pre-postgres")).then(() => true, () => false));
  lib.forgetEngine(pid);
  check("the project now reports PostgreSQL", (await call(`${A}?view=settings`)).json.engine === "postgres" && (await lib.cloudEngine(pid)) === "postgres");
  check("moving again is refused", (await call(A, { action: "moveToPostgres" })).status === 409);

  // ── REST and access rules on Postgres ──
  const mine = await api("/rest/notes?order=title.asc", { bearer: ana });
  check("owner rows: Ana sees her 2 notes", mine.status === 200 && mine.json.length === 2, JSON.stringify(mine.json).slice(0, 200));
  check("values keep their shape after the move (0/1 booleans, numbers)", mine.json[1].done === 1 && Number(mine.json[0].price) === 9.5, JSON.stringify(mine.json[0]));
  check("Bo sees only his note", (await api("/rest/notes", { bearer: bo })).json.length === 1);
  check("signed out: refused", (await api("/rest/notes")).status === 401);
  check("sign-in works on Postgres", (await api("/auth/login", { method: "POST", body: { email: "ana@example.com", password: "password123" } })).status === 200);
  const added = await api("/rest/items", { method: "POST", bearer: ana, body: { note_id: noteId, qty: 1, tag: "c" } });
  check("identity ids continue after the copied rows", added.status === 201 && added.json[0].id === 3, JSON.stringify(added.json));
  check("unique rule copied", (await api("/rest/items", { method: "POST", bearer: ana, body: { note_id: noteId, tag: "c" } })).status === 400);
  check("foreign key copied", (await api("/rest/items", { method: "POST", bearer: ana, body: { note_id: "nope", tag: "z" } })).status === 400);
  check("filters: gt and like", (await api("/rest/items?qty=gt.1.5&tag=like.%25", { bearer: ana })).json.length === 2);
  check("a bad value is a 400, not a crash", (await api("/rest/items?qty=eq.abc", { bearer: ana })).status === 400);
  check("injection in a value matches nothing", (await api(`/rest/items?tag=${encodeURIComponent("eq.a' OR '1'='1")}`, { bearer: ana })).json.length === 0);
  check("unknown column names are refused", (await api(`/rest/items?${encodeURIComponent('tag" = tag --')}=eq.a`, { bearer: ana })).status === 400);
  const patched = await api(`/rest/notes?id=eq.${noteId}`, { method: "PATCH", bearer: bo, body: { title: "hijack" } });
  check("owner rule on writes: Bo can't change Ana's note", patched.json.updated === 0, JSON.stringify(patched.json));
  check("the request log works on Postgres", ((await call(`${A}?view=logs`)).json.logs as unknown[]).length > 0);

  // ── Admin views ──
  const tables = (await call(`${A}?view=tables`)).json.tables as { name: string; rows: number; columns: { name: string; type: string }[] }[];
  check("Database view lists tables with types and counts", tables.find((t) => t.name === "items")?.rows === 3 && tables.find((t) => t.name === "items")!.columns.some((c) => c.type === "bigint"), JSON.stringify(tables.map((t) => [t.name, t.rows])));
  const rows = (await call(`${A}?view=rows&table=notes`)).json as { rows: { _rowid: number; title: string }[]; total: number };
  const bos = rows.rows.find((r) => r.title === "Bo's")!;
  await call(A, { action: "updateRow", table: "notes", rowid: bos._rowid, patch: { title: "Bo's (edited)" } });
  const sql = (await call(A, { action: "sql", sql: "SELECT title FROM notes ORDER BY title" })).json as { rows: { title: string }[] };
  check("row editor works (ctid row ids)", rows.total === 3 && sql.rows?.some((r) => r.title === "Bo's (edited)"), JSON.stringify(sql).slice(0, 200));
  check("SQL editor errors are 400 and change nothing", (await call(A, { action: "sql", sql: "INSERT INTO nope VALUES (1);" })).status === 400);
  const usage = (await call(`${A}?view=usage`)).json as { databaseBytes: number; liveDatabaseBytes: number | null };
  check("Usage shows Postgres database sizes", usage.databaseBytes > 0 && (usage.liveDatabaseBytes ?? 0) > 0, JSON.stringify({ a: usage.databaseBytes, b: usage.liveDatabaseBytes }));
  const liveRows = (await call(`${A}?view=rows&table=notes&env=live`)).json as { total: number };
  check("Live data moved too", liveRows.total === 3, String(liveRows.total));

  // ── Migrations: PostgreSQL SQL, scope fence, Live replay ──
  check("migrations can't reach outside the project", /can't use/i.test(await fails(() => lib.proposeMigration(pid, "x", "COPY notes TO PROGRAM 'id'"))) && /can't use/i.test(await fails(() => lib.proposeMigration(pid, "x", "CREATE TABLE a (id int); COMMIT; DROP TABLE notes"))));
  const m2 = await lib.proposeMigration(pid, "tags", "CREATE TABLE tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, active boolean NOT NULL DEFAULT true, meta jsonb, created_at timestamptz NOT NULL DEFAULT now()); ALTER TABLE notes ADD COLUMN extra text;");
  await lib.applyMigration(pid, m2);
  const tag = await api("/rest/tags", { method: "POST", bearer: ana, body: { name: "x", meta: { a: 1 }, active: false } });
  check("PostgreSQL-dialect tables work through REST (uuid default, boolean, jsonb)", tag.status === 201 && /^[0-9a-f-]{36}$/.test(tag.json[0].id) && tag.json[0].active === false && tag.json[0].meta?.a === 1, JSON.stringify(tag.json));
  check("boolean filters from the client (eq.0)", (await api("/rest/tags?active=eq.0")).json.length === 1);
  const bad = await fails(() => lib.applyMigration(pid, "x"));
  void bad;
  const m3 = await lib.proposeMigration(pid, "broken", "CREATE TABLE half (id int); SELECT * FROM missing_table;");
  const err = await fails(() => lib.applyMigration(pid, m3));
  check("a failing migration changes nothing", /nothing was changed/i.test(err) && !(await lib.listTables(pid)).some((t) => t.name === "half"), err.slice(0, 120));
  const synced = await syncLive(pid);
  const liveCols = Object.keys(((await call(`${A}?view=rows&table=notes&env=live`)).json.rows as Record<string, unknown>[])[0] ?? {});
  check("publishing replays new migrations on Live (Postgres)", synced.applied.length === 1 && liveCols.includes("extra") && (await call(`${A}?view=tables&env=live`)).json.tables.some((t: { name: string }) => t.name === "tags"), JSON.stringify(synced));

  // ── Isolation ──
  const { pid: pid2, anonKey: key2 } = await newProject("PG isolation test");
  ids.push(pid2);
  check("second project moves too", (await call(`/api/projects/${pid2}/cloud/admin`, { action: "moveToPostgres" })).status === 200);
  lib.forgetEngine(pid2);
  await lib.applyMigration(pid2, await lib.proposeMigration(pid2, "secrets", "CREATE TABLE secret_stuff (id text PRIMARY KEY, v text)"));
  await app(pid2, key2)("/rest/secret_stuff", { method: "POST", body: { v: "s" } }).catch(() => undefined);
  const t1 = await lib.pgTarget(pid);
  const t2 = await lib.pgTarget(pid2);
  role1 = t1.user;
  check("each project has its own database and role", t1.database !== t2.database && t1.user !== t2.user && /^fcr_/.test(t1.user));
  const cross = await fails(async () => {
    const c = await asRole(pid, t2.database);
    await c.end();
  });
  check("project 1's role can't connect to project 2's database", /permission denied/i.test(cross), cross.slice(0, 120));
  const platform = new URL(pgLib.pgAdminUrl()).pathname.slice(1);
  // Any table of the platform's own database (read with the admin connection, then tried as the project role).
  const someTable = (await pgLib.adminPool().query("SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LIMIT 1")).rows[0]?.t as string;
  const plat = await fails(async () => {
    const c = await asRole(pid, platform);
    try {
      await c.query(`SELECT * FROM ${someTable} LIMIT 1`);
    } finally {
      await c.end();
    }
  });
  check("project role can't read the platform's tables", /permission denied/i.test(plat), plat.slice(0, 120));
  const own = await asRole(pid, t1.database);
  const rolePowers = (await own.query("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user")).rows[0];
  const ext = await fails(() => own.query("CREATE EXTENSION IF NOT EXISTS dblink"));
  const prog = await fails(() => own.query("COPY (SELECT 1) TO PROGRAM 'echo hi'"));
  await own.end();
  check("the role is not superuser and can't create databases or roles", !rolePowers.rolsuper && !rolePowers.rolcreatedb && !rolePowers.rolcreaterole);
  check("the role can't load extensions or run programs", /permission denied|must be|not allowed/i.test(ext) && /permission denied|must be|privilege/i.test(prog), `${ext.slice(0, 80)} | ${prog.slice(0, 80)}`);
  check("SQL editor runs as the project role (no other databases)", (await call(A, { action: "sql", sql: "SELECT count(*) AS n FROM pg_database WHERE has_database_privilege(datname, 'CONNECT') AND datname NOT LIKE 'template%' AND datname <> 'postgres'" })).json.rows?.[0]?.n <= 4);

  // ── Draft with its own backend ──
  const owner = (await db.project.findUniqueOrThrow({ where: { id: pid } })).createdById!;
  const draft = await createDraft(pid, owner, "PG draft");
  const seeded = await createDraftBackend(pid, draft.id);
  const dd = lib.openDatabase(lib.draftDataId(pid, draft.id));
  const dnotes = await dd.all<{ title: string }>("SELECT title FROM notes");
  check("draft database: same schema, example rows, no live rows or users", seeded.tables.notes > 0 && !dnotes.some((n) => n.title.startsWith("Ana")) && Number((await dd.get<{ n: number }>("SELECT count(*) AS n FROM auth_users"))?.n) === 0, JSON.stringify(seeded.tables));
  await removeDraftBackend(pid, draft.id);
  check("removing the draft backend drops its database", !(await lib.draftDatabaseExists(pid, draft.id)));

  // ── Backups, restore, export ──
  const b = (await call(A, { action: "backup" })).json as { id: string; size: number };
  await call(A, { action: "sql", sql: "DELETE FROM items;" });
  const restored = (await call(A, { action: "restore", backupId: b.id })).json as { safetyBackup: string };
  const items = (await call(`${A}?view=rows&table=items`)).json as { total: number };
  check("restoring a Postgres backup brings rows back", items.total === 3, String(items.total));
  check("REST works right after a restore", (await api("/rest/items", { bearer: ana })).json.length === 3);
  const backups = (await call(`${A}?view=backups`)).json.backups as { id: string }[];
  check("a safety backup is kept before restoring", backups.some((x) => x.id === restored.safetyBackup) && backups.length === 2, JSON.stringify(backups));
  await call(A, { action: "deleteBackup", backupId: restored.safetyBackup });
  check("backups can be deleted", ((await call(`${A}?view=backups`)).json.backups as unknown[]).length === 1);
  const exp = await fetch(`${BASE}${A}?view=export`, { headers: { cookie } });
  const dump = await exp.text();
  check("export is a PostgreSQL SQL dump", exp.status === 200 && dump.startsWith("-- PostgreSQL database dump") && /\.sql"/.test(exp.headers.get("content-disposition") ?? ""));
  const scratch = `fc_dumptest_${Date.now()}`;
  const admin = pgLib.adminPool();
  await admin.query(`CREATE DATABASE ${scratch}`);
  try {
    const u = new URL(pgLib.pgAdminUrl());
    u.pathname = `/${scratch}`;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    await c.query(dump);
    const counts = (await c.query("SELECT (SELECT count(*) FROM notes) AS notes, (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM tags) AS tags, (SELECT count(*) FROM auth_users) AS users")).rows[0];
    await c.query("INSERT INTO items (note_id, qty, tag) VALUES ((SELECT id FROM notes LIMIT 1), 1, 'after-load')");
    const next = (await c.query("SELECT max(id) AS m FROM items")).rows[0];
    await c.end();
    check("the dump loads into an empty database with every row", Number(counts.notes) === 3 && Number(counts.items) === 3 && Number(counts.tags) === 1 && Number(counts.users) === 2, JSON.stringify(counts));
    // Failed inserts earlier used up sequence values (3 rows, ids up to 5 handed out): the next id must be past them.
    check("and its sequences continue", Number(next.m) > 5, JSON.stringify(next));
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  }
} catch (e) {
  check("no unexpected error", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  for (const id of ids) await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  if (role1) {
    await new Promise((r) => setTimeout(r, 1500));
    const left = await pgLib.ownedDatabases(role1).catch(() => ["?"]);
    const roleLeft = (await pgLib.adminPool().query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role1])).rowCount;
    check("deleting the project drops its databases and role", left.length === 0 && !roleLeft, JSON.stringify(left));
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await pgLib.adminPool().end().catch(() => undefined);
  process.exit(failures ? 1 : 0);
}
