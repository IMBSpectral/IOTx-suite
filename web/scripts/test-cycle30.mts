/**
 * Test and Live environments: one database before publishing; the first
 * publish copies Test to Live (schema and data); the live site uses Live while
 * the preview uses Test; the Cloud tab can show either; later publishes bring
 * Live's schema up to date without touching its data.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle30.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fetchRetry: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    await sleep(500);
    return fetch(input, init);
  }
};
const call = async (p: string, body?: unknown) => {
  const r = await fetchRetry(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
async function publish(pid: string) {
  const r = await fetchRetry(`${BASE}/api/projects/${pid}/publish`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
  const text = await r.text();
  const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { type: string; [k: string]: unknown });
  return events.find((e) => e.type === "done" || e.type === "published" || e.type === "error" || e.type === "blocked") ?? events[events.length - 1] ?? { type: "none", text: text.slice(0, 300) };
}
let pid = "";

try {
  pid = ((await call("/api/projects", { name: "C30 guestbook", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const { proposeMigration, applyMigration } = await import("../src/lib/cloud");
  await applyMigration(pid, await proposeMigration(pid, "Guestbook entries", "CREATE TABLE entries (id TEXT PRIMARY KEY, name TEXT NOT NULL);"));
  const p = await db.project.findUniqueOrThrow({ where: { id: pid }, select: { subdomain: true } });
  const site = `http://${p.subdomain}.localhost:3000`;
  let bearer = "";
  const app = (path: string, init: RequestInit & { origin?: string } = {}) =>
    fetchRetry(`${BASE}/cloud/v1/${pid}${path}`, {
      ...init,
      headers: { apikey: anonKey, "user-agent": UA, "content-type": "application/json", ...(init.origin ? { origin: init.origin } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    });
  bearer = ((await (await app("/auth/signup", { method: "POST", body: JSON.stringify({ email: "host@example.com", password: "password123" }) })).json()) as { token: string }).token;
  await app("/rest/entries", { method: "POST", body: JSON.stringify([{ name: "Ana" }, { name: "Bo" }]) });
  check("before publishing there is only Test", (await call(`/api/projects/${pid}/cloud`)).json.hasLive === false);

  const first = await publish(pid);
  if (first.type === "blocked") console.log(JSON.stringify((first as unknown as { result: { checks: { id: string; status: string; summary: string }[] } }).result.checks.map((c) => [c.id, c.status, c.summary])));
  check("the first publish succeeds", first.type !== "error" && first.type !== "blocked" && first.type !== "none", JSON.stringify(first).slice(0, 300));
  check("and creates Live", (await call(`/api/projects/${pid}/cloud`)).json.hasLive === true);
  const liveRows = (await (await app("/rest/entries", { origin: site })).json()) as { name: string }[];
  check("Live starts as a copy of Test (schema and data)", liveRows.length === 2, JSON.stringify(liveRows));
  await app("/rest/entries", { method: "POST", origin: site, body: JSON.stringify({ name: "Cy (a real visitor)" }) });
  const testRows = (await (await app("/rest/entries")).json()) as unknown[];
  const liveNow = (await (await app("/rest/entries", { origin: site })).json()) as unknown[];
  check("the live site writes to Live, the preview keeps Test", liveNow.length === 3 && testRows.length === 2, `${liveNow.length} / ${testRows.length}`);
  const adminLive = (await call(`/api/projects/${pid}/cloud/admin?view=rows&table=entries&env=live`)).json as { total: number };
  const adminTest = (await call(`/api/projects/${pid}/cloud/admin?view=rows&table=entries`)).json as { total: number };
  check("the Cloud tab can show either environment", adminLive.total === 3 && adminTest.total === 2);
  const tables = (await call(`/api/projects/${pid}/cloud/admin?view=tables&env=live`)).json.tables as { name: string }[];
  check("including Live's tables", tables.some((t) => t.name === "entries"));

  await applyMigration(pid, await proposeMigration(pid, "Add a message", "ALTER TABLE entries ADD COLUMN message TEXT;"));
  const cols = async (env: string) => Object.keys(((await call(`/api/projects/${pid}/cloud/admin?view=rows&table=entries${env}`)).json.rows as Record<string, unknown>[])[0] ?? {});
  check("a new database change lands in Test first", (await cols("")).includes("message") && !(await cols("&env=live")).includes("message"));
  const second = await publish(pid);
  check("the next publish succeeds", second.type !== "error" && second.type !== "blocked", JSON.stringify(second).slice(0, 200));
  check("and brings Live's schema up to date", (await cols("&env=live")).includes("message"));
  check("without touching Live's data", ((await call(`/api/projects/${pid}/cloud/admin?view=rows&table=entries&env=live`)).json.total as number) === 3);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
