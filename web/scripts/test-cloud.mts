/**
 * Forge Cloud end to end: enable (client file installed), migrations
 * (validation, approval, atomic failure), the app REST API with auth and
 * owner rules, secrets, CORS, and internal tables staying private.
 * Proposing a migration is an agent tool, so the test calls the library for it.
 *   npx tsx scripts/test-cloud.mts <devToken>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { proposeMigration, queryDatabase, readSecret } from "../src/lib/cloud";
import { PROJECTS_ROOT } from "../src/lib/paths";

const BASE = "http://localhost:3000";
const token = process.argv[2];
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function editor(p: string, json?: unknown) {
  const res = await fetch(BASE + p, {
    method: json === undefined ? "GET" : "POST",
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function main() {
  const created = await editor("/api/projects", { name: `Cloud test ${Date.now()}`, force: true });
  const pid = created.body.project.id as string;
  const C = `/api/projects/${pid}/cloud`;
  try {
    check("cloud off by default", (await editor(C)).body.enabled === false);
    const en = await editor(C, { action: "enable" });
    check("enable cloud", en.status === 200);
    const files = (await editor(`/api/projects/${pid}/files`)).body.files as string[];
    check("client file installed", files.includes("src/integrations/cloud/client.ts"));
    const state = (await editor(C)).body;
    const key = state.anonKey as string;
    const app = async (p: string, init: { method?: string; body?: unknown; bearer?: string; apikey?: string | null } = {}) => {
      const res = await fetch(`${state.url}${p}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.apikey === null ? {} : { apikey: init.apikey ?? key }),
          "content-type": "application/json",
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any, headers: res.headers };
    };

    let blocked = "";
    await proposeMigration(pid, "attach", "ATTACH DATABASE 'x.db' AS x").catch((e) => (blocked = e.message));
    check("ATTACH refused", /can't use ATTACH/.test(blocked));
    const mid = await proposeMigration(
      pid,
      "Create todos",
      "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, user_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);",
    );
    let pending = (await editor(C)).body;
    check("migration pending, table not created", pending.migrations[0].status === "pending" && pending.tables.length === 0);
    check("approve migration", (await editor(C, { action: "approve", id: mid })).status === 200);
    pending = (await editor(C)).body;
    check("table exists after approval", pending.tables.some((t: any) => t.name === "todos"));
    check("re-approve refused", (await editor(C, { action: "approve", id: mid })).status === 400);

    const bad = await proposeMigration(pid, "Broken", "CREATE TABLE notes (id TEXT PRIMARY KEY); CREATE TABLE oops (;");
    const badRes = await editor(C, { action: "approve", id: bad });
    pending = (await editor(C)).body;
    check("failed migration is atomic", badRes.status === 400 && !pending.tables.some((t: any) => t.name === "notes") && pending.migrations.find((m: any) => m.id === bad).status === "failed");

    check("no apikey → 401", (await app("/rest/todos", { apikey: null })).status === 401);
    check("public read works", (await app("/rest/todos")).body.length === 0);
    check("anonymous write refused", (await app("/rest/todos", { method: "POST", body: { title: "x" } })).status === 401);

    const u1 = await app("/auth/signup", { method: "POST", body: { email: "ana@example.com", password: "correct horse" } });
    check("signup", u1.status === 201 && !!u1.body.token);
    check("duplicate signup refused", (await app("/auth/signup", { method: "POST", body: { email: "ana@example.com", password: "correct horse" } })).status === 409);
    check("short password refused", (await app("/auth/signup", { method: "POST", body: { email: "b@example.com", password: "short" } })).status === 400);
    check("wrong password refused", (await app("/auth/login", { method: "POST", body: { email: "ana@example.com", password: "nope nope" } })).status === 401);
    const login = await app("/auth/login", { method: "POST", body: { email: "ana@example.com", password: "correct horse" } });
    check("login", login.status === 200 && login.body.user.email === "ana@example.com");
    check("current user", (await app("/auth/user", { bearer: login.body.token })).body.user?.id === u1.body.user.id);

    const ins = await app("/rest/todos", { method: "POST", bearer: u1.body.token, body: { title: "Buy milk", user_id: "spoofed" } });
    const row = ins.body[0];
    check("insert fills id and user_id", ins.status === 201 && !!row.id && row.user_id === u1.body.user.id, JSON.stringify(ins.body));

    const u2 = await app("/auth/signup", { method: "POST", body: { email: "ben@example.com", password: "another pass" } });
    check("set owner access", (await editor(C, { action: "policy", table: "todos", read: "owner", write: "owner" })).status === 200);
    check("owner sees own rows", (await app("/rest/todos", { bearer: u1.body.token })).body.length === 1);
    check("other user sees none", (await app("/rest/todos", { bearer: u2.body.token })).body.length === 0);
    check("anonymous can't read owner table", (await app("/rest/todos")).status === 401);
    const steal = await app(`/rest/todos?id=eq.${row.id}`, { method: "PATCH", bearer: u2.body.token, body: { title: "hacked" } });
    check("other user can't update", steal.body.updated === 0);
    check("update needs a filter", (await app("/rest/todos", { method: "PATCH", bearer: u1.body.token, body: { done: 1 } })).status === 400);
    check("owner updates", (await app(`/rest/todos?id=eq.${row.id}`, { method: "PATCH", bearer: u1.body.token, body: { done: true } })).body.updated === 1);
    const filtered = await app("/rest/todos?done=eq.1&order=created_at.desc&limit=5", { bearer: u1.body.token });
    check("filter + order", filtered.body.length === 1 && filtered.body[0].done === 1);
    check("unknown column refused", (await app("/rest/todos?nope=eq.1", { bearer: u1.body.token })).status === 400);
    check("owner deletes", (await app(`/rest/todos?id=eq.${row.id}`, { method: "DELETE", bearer: u1.body.token })).body.deleted === 1);

    check("auth_users private", (await app("/rest/auth_users")).status === 404);
    check("migrations table private", (await app("/rest/_forge_migrations")).status === 404);
    const pre = await fetch(`${state.url}/rest/todos`, { method: "OPTIONS" });
    check("CORS preflight", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*");

    check("bad secret name refused", (await editor(C, { action: "setSecret", name: "lower", value: "x" })).status === 400);
    await editor(C, { action: "setSecret", name: "STRIPE_KEY", value: "sk_test_123" });
    const withSecret = (await editor(C)).body;
    check("secret listed by name only", withSecret.secrets.some((s: any) => s.name === "STRIPE_KEY") && !JSON.stringify(withSecret).includes("sk_test_123"));
    check("secret decrypts server-side", (await readSecret(pid, "STRIPE_KEY")) === "sk_test_123");
    const cfgRaw = await fs.readFile(path.join(PROJECTS_ROOT, "_cloud", pid, "config.json"), "utf8");
    check("secret encrypted at rest", !cfgRaw.includes("sk_test_123"));

    check("agent query: select", (await queryDatabase(pid, "SELECT count(*) AS n FROM auth_users"))[0].n === 2);
    let ro = "";
    await queryDatabase(pid, "DELETE FROM todos").catch((e) => (ro = e.message));
    check("agent query: writes refused", /Only SELECT/.test(ro));
    const users = await queryDatabase(pid, "SELECT * FROM auth_users");
    check("agent never sees password hashes", users.every((u) => u.password_hash === "[hidden]"));
  } finally {
    await editor("/api/projects/bulk", { action: "delete", ids: [pid] });
    await editor("/api/projects/bulk", { action: "purge", ids: [pid] });
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
