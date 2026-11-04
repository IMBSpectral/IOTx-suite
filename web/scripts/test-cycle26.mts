/**
 * Workspace API keys and the Forge MCP server: keys shown once and stored
 * hashed, scopes (tools hidden and refused), project access, read-only SQL,
 * turns started through MCP (labelled, tied to the key), the per-key monthly
 * credit limit, revocation.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle26.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
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
const call = async (p: string, body?: unknown, c = cookie) => {
  const r = await fetchRetry(`${BASE}${p}`, body === undefined ? { headers: { cookie: c } } : { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
let n = 0;
const mcp = async (key: string, method: string, params?: unknown) => {
  const r = await fetchRetry(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params ? { params } : {}) }),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const tool = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp(key, "tools/call", { name, arguments: args });
  const res = r.json.result as { content: { text: string }[]; isError?: boolean };
  return { error: !!res?.isError, text: res?.content?.[0]?.text ?? "" };
};
let pid = "";
const keyIds: string[] = [];

try {
  pid = ((await call("/api/projects", { name: "C26 mcp target", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  await call(`/api/projects/${pid}/cloud/admin`, { action: "sql", sql: "CREATE TABLE fruit (id TEXT PRIMARY KEY, name TEXT); INSERT INTO fruit VALUES ('1','apple'),('2','pear');" });

  check("a key needs a scope", (await call("/api/workspace/api-keys", { action: "create", name: "none", scopes: [] })).status === 400);
  const ro = await call("/api/workspace/api-keys", { action: "create", name: "C26 read", scopes: ["read", "database"] });
  keyIds.push(ro.json.id);
  const roKey = ro.json.token as string;
  check("a new key is shown once", ro.status === 201 && /^forge_/.test(roKey));
  const listed = (await call("/api/workspace/api-keys")).json as { keys: { id: string; prefix: string }[]; mcpUrl: string };
  check("listed keys show only a prefix", listed.keys.some((k) => k.id === ro.json.id && roKey.startsWith(k.prefix)) && !JSON.stringify(listed).includes(roKey));

  check("the MCP server needs a key", (await fetchRetry(`${BASE}/api/mcp`, { method: "POST", body: "{}" })).status === 401);
  const init = await mcp(roKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check("an MCP client can connect", init.status === 200 && /IOTx|Forge/.test(init.json.result?.serverInfo?.name ?? ""));
  const tools = ((await mcp(roKey, "tools/list")).json.result.tools as { name: string }[]).map((t) => t.name);
  check("only tools the scopes allow are listed", tools.includes("list_projects") && tools.includes("query_database") && !tools.includes("publish_project"), tools.join(","));

  const projects = JSON.parse((await tool(roKey, "list_projects", { query: "C26" })).text) as { id: string }[];
  check("it lists the workspace's projects", projects.some((p) => p.id === pid));
  const proj = JSON.parse((await tool(roKey, "get_project", { projectId: pid })).text) as { cloud: boolean };
  check("and reads a project", proj.cloud === true);
  const rows = JSON.parse((await tool(roKey, "query_database", { projectId: pid, sql: "SELECT name FROM fruit ORDER BY name" })).text) as { name: string }[];
  check("read-only SQL works", rows.map((r) => r.name).join(",") === "apple,pear");
  check("writes are refused", (await tool(roKey, "query_database", { projectId: pid, sql: "DELETE FROM fruit" })).error);
  check("tricks with a second statement are refused", (await tool(roKey, "query_database", { projectId: pid, sql: "SELECT 1; DELETE FROM fruit" })).error);
  check("a build needs the build scope", /scope/.test((await tool(roKey, "send_message", { projectId: pid, message: "Add a header" })).text));
  check("publishing needs the deploy scope", /scope/.test((await tool(roKey, "publish_project", { projectId: pid })).text));

  // Turns through MCP
  const bk = await call("/api/workspace/api-keys", { action: "create", name: "C26 build", scopes: ["read", "build"], monthlyLimit: 3 });
  keyIds.push(bk.json.id);
  const bKey = bk.json.token as string;
  const sent = JSON.parse((await tool(bKey, "send_message", { projectId: pid, message: "In one sentence: what is this project?", mode: "ask" })).text) as { buildId: string };
  const build = await db.build.findUnique({ where: { id: sent.buildId } });
  const userMsg = await db.message.findFirst({ where: { projectId: pid, role: "USER" }, orderBy: { createdAt: "desc" } });
  check("send_message queues a turn tied to the key, labelled as from MCP", build?.apiKeyId === bk.json.id && userMsg?.mode === "api");
  let status = "";
  for (let i = 0; i < 40 && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(status); i++) {
    await sleep(3000);
    status = (JSON.parse((await tool(bKey, "get_build", { buildId: sent.buildId })).text) as { status: string }).status;
  }
  check("get_build follows it to the end", status === "SUCCEEDED", status);
  await db.build.update({ where: { id: sent.buildId }, data: { creditsUsed: 3 } });
  const over = await tool(bKey, "send_message", { projectId: pid, message: "Add a footer" });
  check("the key's monthly credit limit stops new builds", over.error && /monthly limit/.test(over.text), over.text);
  const used = ((await call("/api/workspace/api-keys")).json.keys as { id: string; usedThisMonth: number }[]).find((k) => k.id === bk.json.id);
  check("the key shows its credits this month", used?.usedThisMonth === 3);

  // Other workspaces and revocation
  const outsiderKey = await call("/api/workspace/api-keys", { action: "create", name: "C26 outsider", scopes: ["read"] }, `authjs.session-token=${users["outsider@localhost"]}`);
  if (outsiderKey.json.token) {
    const theirs = JSON.parse((await tool(outsiderKey.json.token, "list_projects")).text || "[]") as { id: string }[];
    check("another workspace's key can't see these projects", !theirs.some((p) => p.id === pid));
    check("or open one directly", (await tool(outsiderKey.json.token, "get_project", { projectId: pid })).error);
    await call("/api/workspace/api-keys", { action: "revoke", id: outsiderKey.json.id }, `authjs.session-token=${users["outsider@localhost"]}`);
  }
  await call("/api/workspace/api-keys", { action: "revoke", id: ro.json.id });
  check("a revoked key stops working", (await mcp(roKey, "tools/list")).status === 401);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of keyIds) await call("/api/workspace/api-keys", { action: "revoke", id }).catch(() => undefined);
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
