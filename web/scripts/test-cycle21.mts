/**
 * Cloud manager: SQL editor, table rows (insert/edit/delete), app users
 * (create, sign in with the generated password, reset, delete), the request
 * log, backups (back up, change, restore, safety copy) and export; outsiders
 * are refused.
 *   npx tsx scripts/test-cycle21.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (path: string, body?: unknown, c = cookie) => {
  const r = await fetch(`${BASE}${path}`, body === undefined ? { headers: { cookie: c } } : { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
let pid = "";

try {
  pid = ((await call("/api/projects", { name: "C21 cloud manager", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const cfg = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const A = `/api/projects/${pid}/cloud/admin`;

  // SQL editor
  const create = await call(A, { action: "sql", sql: "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);" });
  check("SQL editor runs a statement", create.status === 200 && create.json.kind === "done", JSON.stringify(create.json));
  const bad = await call(A, { action: "sql", sql: "INSERT INTO nope VALUES (1);" });
  check("a failing statement changes nothing and says why", bad.status === 400 && /nothing was changed/i.test(String(bad.json.error)), String(bad.json.error));

  // Rows
  await call(A, { action: "insertRow", table: "notes", row: { title: "First" } });
  await call(A, { action: "insertRow", table: "notes", row: { title: "Second", done: 1 } });
  const rows = (await call(`${A}?view=rows&table=notes`)).json as { rows: { _rowid: number; id: string; title: string }[]; total: number };
  check("rows are inserted with an id filled in", rows.total === 2 && rows.rows.every((r) => !!r.id), JSON.stringify(rows.rows.map((r) => r.title)));
  const first = rows.rows.find((r) => r.title === "First")!;
  await call(A, { action: "updateRow", table: "notes", rowid: first._rowid, patch: { title: "First (edited)" } });
  const sel = (await call(A, { action: "sql", sql: "SELECT title FROM notes ORDER BY title" })).json as { rows: { title: string }[] };
  check("a row can be edited, and SELECT returns rows", sel.rows?.map((r) => r.title).join(",") === "First (edited),Second", JSON.stringify(sel));
  check("unknown columns are refused", (await call(A, { action: "updateRow", table: "notes", rowid: first._rowid, patch: { "title = 'x' --": "y" } })).status === 400);
  check("internal tables can't be browsed", (await call(`${A}?view=rows&table=auth_users`)).status === 404);

  // Users
  const u = (await call(A, { action: "createUser", email: "ana@example.com" })).json as { id: string; generatedPassword: string };
  const signIn = await fetch(`${BASE}/cloud/v1/${pid}/auth/login`, { method: "POST", headers: { apikey: cfg.anonKey, "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0" }, body: JSON.stringify({ email: "ana@example.com", password: u.generatedPassword }) });
  check("a user added by hand can sign in with the generated password", signIn.status === 200 && !!u.generatedPassword, String(signIn.status));
  const reset = (await call(A, { action: "setPassword", userId: u.id, password: "brand-new-pass" })).json;
  const old = await fetch(`${BASE}/cloud/v1/${pid}/auth/login`, { method: "POST", headers: { apikey: cfg.anonKey, "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0" }, body: JSON.stringify({ email: "ana@example.com", password: u.generatedPassword }) });
  check("resetting the password replaces the old one", old.status === 401 && reset.generatedPassword === null);
  const list = (await call(`${A}?view=users&q=ana`)).json as { users: { email: string }[] };
  check("users can be searched", list.users.length === 1 && list.users[0].email === "ana@example.com");
  await call(A, { action: "deleteUser", userId: u.id });
  check("and deleted", ((await call(`${A}?view=users`)).json.users as unknown[]).length === 0);

  // Logs
  await fetch(`${BASE}/cloud/v1/${pid}/rest/notes`, { headers: { apikey: cfg.anonKey } });
  await fetch(`${BASE}/cloud/v1/${pid}/rest/missing_table`, { headers: { apikey: cfg.anonKey } });
  const logs = (await call(`${A}?view=logs`)).json as { logs: { path: string; status: number; method: string }[] };
  check("app requests land in the log", logs.logs.some((l) => l.path.startsWith("/rest/notes") && l.status === 200 && l.method === "GET"), JSON.stringify(logs.logs.slice(0, 3)));
  const errs = (await call(`${A}?view=logs&errors=1`)).json as { logs: { status: number }[] };
  check("the log can show errors only", errs.logs.length > 0 && errs.logs.every((l) => l.status >= 400));

  // Backups
  const b = (await call(A, { action: "backup" })).json as { id: string };
  await call(A, { action: "sql", sql: "DELETE FROM notes;" });
  const restored = (await call(A, { action: "restore", backupId: b.id })).json as { safetyBackup: string };
  const after = (await call(`${A}?view=rows&table=notes`)).json as { total: number };
  check("restoring a backup brings the rows back", after.total === 2, String(after.total));
  const backups = (await call(`${A}?view=backups`)).json as { backups: { id: string }[] };
  check("a safety copy is kept before restoring", backups.backups.some((x) => x.id === restored.safetyBackup) && backups.backups.length === 2);
  const exp = await fetch(`${BASE}${A}?view=export`, { headers: { cookie } });
  const bytes = Buffer.from(await exp.arrayBuffer());
  // The export follows the project's engine: a SQLite file, or a SQL dump for PostgreSQL projects (FORGE_CLOUD_ENGINE=postgres).
  const engine = (await call(`${A}?view=settings`)).json.engine;
  if (engine === "postgres") check("the database exports as a PostgreSQL SQL dump", exp.status === 200 && bytes.toString("utf8").startsWith("-- PostgreSQL database dump"));
  else check("the database exports as a SQLite file", exp.status === 200 && bytes.subarray(0, 15).toString() === "SQLite format 3");

  // Access
  const outsider = `authjs.session-token=${users["outsider@localhost"]}`;
  check("people without edit access are refused", (await call(`${A}?view=users`, undefined, outsider)).status === 403 || (await call(`${A}?view=users`, undefined, outsider)).status === 404);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
