/**
 * MCP (the app's own MCP server, and connecting a remote one), connector
 * request metering, documents and the Artifacts API, the stress test, and the
 * security digest's MCP exposure. The remote MCP check uses DeepWiki's public
 * server (https://mcp.deepwiki.com/mcp); it's skipped if unreachable.
 *   npx tsx scripts/test-mcp-artifacts.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { closeDatabase, enableCloud, openDatabase } from "../src/lib/cloud";
import { openMcp } from "../src/lib/mcp";
import { mcpCall, mcpTools } from "../src/lib/connectors";
import { createDocument } from "../src/lib/visuals";
import { buildDigest } from "../src/lib/workspace-security";

const BASE = "http://localhost:3000";
const REMOTE = "https://mcp.deepwiki.com/mcp";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const rpc = (url: string, auth: string | null, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });

let pid = "";
let connectorId = "";
let wsId = "";
try {
  const created = await fetch(`${BASE}/api/projects`, json("POST", { name: "MCP artifacts test", force: true }));
  pid = ((await created.json()) as { project: { id: string } }).project.id;
  wsId = (await db.project.findUniqueOrThrow({ where: { id: pid } })).workspaceId;

  // ── The app's MCP server ──
  const before = await (await fetch(`${BASE}/api/projects/${pid}/mcp`, { headers: { cookie } })).json();
  check("MCP needs Cloud first", before.cloud === false && (await fetch(`${BASE}/api/projects/${pid}/mcp`, json("POST", { action: "enable" }))).status === 409);
  await enableCloud(pid);
  openDatabase(pid).exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL); INSERT INTO notes (title) VALUES ('first');");
  closeDatabase(pid);
  const on = await (await fetch(`${BASE}/api/projects/${pid}/mcp`, json("POST", { action: "enable" }))).json();
  check("MCP server turned on, token shown once", on.enabled && /^fmcp_/.test(on.token ?? "") && on.url.endsWith(`/cloud/v1/${pid}/mcp`));
  const url = on.url as string;
  check("no token: 401", (await rpc(url, null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status === 401);
  check("wrong token: 401", (await rpc(url, "fmcp_wrong", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status === 401);
  const init = await (await rpc(url, on.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  check("initialize names the app", /MCP artifacts test/.test(init.result?.serverInfo?.name ?? ""), JSON.stringify(init).slice(0, 120));
  check("notification gets 202", (await rpc(url, on.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status === 202);
  const tools = await (await rpc(url, on.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  check("three tools", tools.result?.tools?.map((t: { name: string }) => t.name).join(",") === "list_tables,query_table,insert_row");
  const call = async (name: string, args: unknown) => (await (await rpc(url, on.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })).json()).result;
  const lt = await call("list_tables", {});
  check("list_tables sees the app's table, not internal ones", /"notes"/.test(lt.content[0].text) && !/auth_users/.test(lt.content[0].text));
  const ins = await call("insert_row", { table: "notes", row: { title: "from MCP" } });
  check("insert_row adds a row", !ins.isError && /Added 1 row/.test(ins.content[0].text));
  const q = await call("query_table", { table: "notes", where: { title: "from MCP" } });
  check("query_table filters", JSON.parse(q.content[0].text).length === 1);
  const bad = await call("query_table", { table: "auth_users" });
  check("internal tables refused", bad.isError === true);
  const inj = await call("query_table", { table: "notes", where: { 'title" OR 1=1 --': "x" } });
  check("unknown columns refused (no SQL injection)", inj.isError === true);
  check("unknown method", (await (await rpc(url, on.token, { jsonrpc: "2.0", id: 9, method: "resources/list" })).json()).error?.code === -32601);
  const rotated = await (await fetch(`${BASE}/api/projects/${pid}/mcp`, json("POST", { action: "rotate" }))).json();
  check("rotating revokes the old token", (await rpc(url, on.token, { jsonrpc: "2.0", id: 1, method: "ping" })).status === 401 && (await rpc(url, rotated.token, { jsonrpc: "2.0", id: 1, method: "ping" })).ok);
  const digest = await buildDigest(wsId);
  check("digest lists the app serving data over MCP", digest.exposure.mcp.appServers.includes("MCP artifacts test"));
  await fetch(`${BASE}/api/projects/${pid}/mcp`, json("POST", { action: "disable" }));
  check("turned off: 404", (await rpc(url, rotated.token, { jsonrpc: "2.0", id: 1, method: "ping" })).status === 404);

  // ── Remote MCP server as a connector ──
  let reachable = true;
  try {
    const s = await openMcp(REMOTE);
    const t = await s.listTools();
    check("MCP client: initialize + tools/list on a real server", t.length > 0, `${s.serverName}: ${t.map((x) => x.name).join(", ")}`);
  } catch (e) {
    reachable = false;
    console.log(`SKIP remote MCP server unreachable — ${String(e).slice(0, 120)}`);
  }
  check("private addresses refused", await openMcp("http://127.0.0.1:3000/x").then(() => false, () => true));
  check("https required", (await fetch(`${BASE}/api/workspace/connectors`, json("POST", { action: "connect", kind: "mcp", values: { url: "http://example.com/mcp" } }))).status === 400);
  if (reachable) {
    const c = await (await fetch(`${BASE}/api/workspace/connectors`, json("POST", { action: "connect", kind: "mcp", label: "DeepWiki test", values: { url: REMOTE } }))).json();
    connectorId = c.id;
    check("MCP connector connects (no token needed)", !!c.id, JSON.stringify(c).slice(0, 120));
    const listed = await mcpTools(wsId, pid, "DeepWiki test");
    check("agent tool listing", listed.tools.length > 0);
    const t0 = Date.now();
    const r = await mcpCall(wsId, pid, "DeepWiki test", "read_wiki_structure", { repoName: "facebook/react" });
    check("agent tool call returns text", !r.isError && r.text.length > 20, `${Math.round((Date.now() - t0) / 1000)}s ${r.text.slice(0, 80).replace(/\n/g, " ")}`);
    const billing = await (await fetch(`${BASE}/api/workspace/billing`, { headers: { cookie } })).json();
    check("connector requests metered in billing", billing.connectorRequests?.some((x: { kind: string; requests: number }) => x.kind === "mcp" && x.requests >= 1), JSON.stringify(billing.connectorRequests));
    check("digest counts connected MCP servers", (await buildDigest(wsId)).exposure.mcp.connected >= 1);
  }

  // ── Documents and artifacts ──
  const doc = await createDocument(pid, "Launch checklist", "# Launch\n\n- [ ] Domain\n- [ ] Analytics\n\n<script>alert(1)</script>");
  const list = await (await fetch(`${BASE}/api/projects/${pid}/artifacts`, { headers: { cookie } })).json();
  check("artifacts list includes the document", list.artifacts.some((a: { id: string; kind: string }) => a.id === doc.id && a.kind === "doc"));
  const one = await (await fetch(`${BASE}/api/projects/${pid}/artifacts?id=${doc.id}`, { headers: { cookie } })).json();
  check("document markdown served", one.markdown.startsWith("# Launch"));
  const raw = await (await fetch(`${BASE}/api/projects/${pid}/visuals/${doc.id}`, { headers: { cookie } })).text();
  check("document served directly is escaped text", raw.includes("&lt;script>") && !raw.includes("<script>alert"));
  check("artifacts need access", (await fetch(`${BASE}/api/projects/${pid}/artifacts`)).status === 401);

  // ── Stress test ──
  check("stress test needs a published app", (await fetch(`${BASE}/api/projects/${pid}/stress`, json("POST", { seconds: 1 }))).status === 409);
  const published = await db.project.findFirst({ where: { workspaceId: wsId, publishedSha: { not: null }, deletedAt: null }, select: { id: true, name: true } });
  if (published) {
    const st = await (await fetch(`${BASE}/api/projects/${published.id}/stress`, json("POST", { concurrency: 999, seconds: 2 }))).json();
    const r = st.result;
    check("stress test runs, capped at 50 at once", !!r && r.concurrency === 50 && r.requests > 0 && r.latencyMs.p50 >= 0, r ? `${published.name}: ${r.requests} req, ${r.rps}/s, p50 ${r.latencyMs.p50}ms, p99 ${r.latencyMs.p99}ms, errors ${r.errors}, ${JSON.stringify(r.statuses)}` : JSON.stringify(st));
  } else console.log("SKIP no published project in the workspace for the stress test");
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (connectorId) await fetch(`${BASE}/api/workspace/connectors`, json("POST", { action: "disconnect", id: connectorId }));
  if (pid) {
    closeDatabase(pid);
    const del = await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
    check("test project deleted", del.ok, String(del.status));
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
