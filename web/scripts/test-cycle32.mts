/**
 * Cloud usage (requests, AI, functions, sizes per day), the connector request
 * log and usage per connection, the "Features tried" checklist, and memory
 * management (switch, add/delete, personal memory across projects, what's
 * followed each turn, tidy-up and undo).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle32.mts <devToken>
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
let pid = "";
const NOTION = `C32 Notion ${Date.now().toString(36)}`;
const STRIPE = `C32 Stripe ${Date.now().toString(36)}`;
const ws = (await call("/api/workspace")).json.workspace as { id: string };
const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const mineBefore = (await call("/api/account/memory")).json.facts as string[];

try {
  // ── Cloud usage
  pid = ((await call("/api/projects", { name: "C32 usage", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  for (const path of ["/rest/nope", "/auth/user", "/auth/user"]) await fetchRetry(`${BASE}/cloud/v1/${pid}${path}`, { headers: { apikey: anonKey, "user-agent": UA } });
  const u = (await call(`/api/projects/${pid}/cloud/admin?view=usage`)).json as { days: { day: string; requests: number; errors: number }[]; databaseBytes: number; storage: { files: number } };
  const today = u.days[u.days.length - 1];
  check("Cloud usage counts today's requests and errors", u.days.length === 30 && today.requests >= 3 && today.errors >= 3, JSON.stringify(today));
  check("and shows the database size", u.databaseBytes > 0);

  // ── Connector log
  const { logConnectorRequest } = await import("../src/lib/connector-log");
  await logConnectorRequest(ws.id, { projectId: pid, connection: NOTION, kind: "notion", request: "POST /v1/databases/abc/query?token=secret123", status: 200, ms: 120 });
  await logConnectorRequest(ws.id, { projectId: pid, connection: NOTION, kind: "notion", request: "GET /v1/users", status: 401, ms: 80 });
  await logConnectorRequest(ws.id, { projectId: null, connection: STRIPE, kind: "stripe", request: "GET /v1/products", status: 200, ms: 90 });
  const cl = (await call(`/api/workspace/connector-logs?projectId=${pid}`)).json as { usage: { connection: string; requests: number; errors: number }[]; log: { request: string }[] };
  const notion = cl.usage.find((x) => x.connection === NOTION);
  check("usage is counted per connection", notion?.requests === 2 && notion.errors === 1 && cl.usage.some((x) => x.connection === STRIPE));
  check("the log can be filtered to one project", cl.log.length === 2 && cl.log.every((e) => e.request.includes("/v1/")));
  check("query strings (where tokens hide) aren't kept", !JSON.stringify(cl).includes("secret123"));

  // ── Features tried
  const ft = (await call("/api/account/features")).json as { features: { id: string; tried: boolean }[]; lastProject: { id: string } | null };
  check("the checklist knows what's been tried", ft.features.find((f) => f.id === "build")?.tried === true && ft.features.find((f) => f.id === "cloud")?.tried === true, JSON.stringify(ft.features.map((f) => `${f.id}:${f.tried}`)));
  check("and offers to continue the latest project", ft.lastProject?.id === pid);

  // ── Memory
  const M = `/api/projects/${pid}/memory`;
  await call(M, { action: "add", fact: "Prices are always shown in euros" });
  await call(M, { action: "add", fact: "Prices are in euros" });
  await call(M, { action: "add", fact: "The brand colour is teal" });
  let f = (await call(M)).json as { projectMemories: string[]; personalMemories: string[]; memoryEnabled: boolean; canUndoTidy: boolean };
  check("memories can be added to a project", f.projectMemories.length === 3);
  await call("/api/account/memory", { action: "add", fact: "C32: likes short labels" });
  f = (await call(M)).json as typeof f;
  check("personal memory shows in every project's summary", f.personalMemories.includes("C32: likes short labels"));
  const { effectiveKnowledge } = await import("../src/lib/memory");
  const k = await db.knowledge.findUnique({ where: { projectId: pid } });
  const on = (await effectiveKnowledge(pid, k?.content ?? null, dev.id)) ?? "";
  check("the agent gets project and personal memories each turn", on.includes("brand colour is teal") && on.includes("C32: likes short labels"));
  await call(M, { action: "toggle", enabled: false });
  const off = (await effectiveKnowledge(pid, k?.content ?? null, dev.id)) ?? "";
  check("with memory off, project memories are left out", !off.includes("brand colour is teal") && off.includes("C32: likes short labels"));
  await call(M, { action: "toggle", enabled: true });
  const tidy = await call(M, { action: "tidy" });
  f = (await call(M)).json as typeof f;
  check("tidy-up merges duplicate memories", tidy.status === 200 && f.projectMemories.length === 2 && f.canUndoTidy, JSON.stringify(f.projectMemories));
  await call(M, { action: "undo" });
  f = (await call(M)).json as typeof f;
  check("and can be undone", f.projectMemories.length === 3 && !f.canUndoTidy);
  await call(M, { action: "delete", fact: "The brand colour is teal" });
  check("memories can be deleted", !((await call(M)).json.projectMemories as string[]).includes("The brand colour is teal"));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const m of (await call("/api/account/memory")).json.facts as string[]) if (!mineBefore.includes(m)) await call("/api/account/memory", { action: "delete", fact: m });
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
