/**
 * Durable workflows (schema-checked input, function steps, approval, events,
 * sleep woken by the scheduler, failure + retry, cancel) and custom
 * connectors ("Connect your own API" against httpbin.org, credential checked,
 * requests locked to its host, removal).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle33.mts <devToken>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
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
let connId = "";
let defKind = "";

try {
  // ── Workflows
  pid = ((await call("/api/projects", { name: "C33 refunds", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const repo = path.join(ROOT, pid);
  await fs.mkdir(path.join(repo, "functions"), { recursive: true });
  await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
  await fs.writeFile(path.join(repo, "functions", "quote.ts"), `export default async (req: Request) => { const b = await req.json(); return { amount: b.input.amount, fee: 2, runId: b.runId }; };`);
  await fs.writeFile(path.join(repo, "functions", "pay.ts"), `export default async (req: Request) => { const b = await req.json(); if (b.input.amount > 900) throw new Error("bank said no"); return { paid: b.input.amount + b.steps.quote.fee, approvedBy: b.steps.review.by, receipt: b.steps.receipt.data }; };`);
  await fs.writeFile(
    path.join(repo, "workflows", "refund.json"),
    JSON.stringify({
      input: { type: "object", required: ["amount", "email"], properties: { amount: { type: "number" }, email: { type: "string" } } },
      steps: [
        { id: "quote", type: "function", function: "quote" },
        { id: "review", type: "approval", message: "Approve this refund?" },
        { id: "receipt", type: "event", event: "receipt.uploaded", timeoutHours: 1 },
        { id: "cool-off", type: "sleep", seconds: 2 },
        { id: "pay", type: "function", function: "pay" },
      ],
    }),
  );
  await call(`/api/projects/${pid}/cloud/admin`, { action: "deployFunctions" });
  const app = (p: string, body?: unknown) =>
    fetchRetry(`${BASE}/cloud/v1/${pid}${p}`, { method: body === undefined ? "GET" : "POST", headers: { apikey: anonKey, "user-agent": UA, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const runOf = async (id: string) => (await (await app(`/workflows/runs/${id}`)).json()) as { status: string; waiting: { type: string } | null; error: string | null; steps: { id: string; status: string; output: Record<string, unknown> | null }[] };
  const until = async (id: string, ok: (r: Awaited<ReturnType<typeof runOf>>) => boolean, ms = 60_000) => {
    const t = Date.now();
    let r = await runOf(id);
    while (!ok(r) && Date.now() - t < ms) {
      await sleep(1000);
      r = await runOf(id);
    }
    return r;
  };

  const bad = await app("/workflows/refund/runs", { input: { amount: "lots" } });
  check("a run's input is checked against the workflow's schema", bad.status === 400 && /email is required|amount should be/.test(((await bad.json()) as { error: string }).error));
  const started = (await (await app("/workflows/refund/runs", { input: { amount: 40, email: "a@example.com" } })).json()) as { id: string };
  let r = await until(started.id, (x) => x.status === "waiting");
  check("function steps run, then the run waits for an approval", r.waiting?.type === "approval" && r.steps.find((s) => s.id === "quote")?.output?.fee === 2, JSON.stringify(r).slice(0, 300));
  check("sending an event it isn't waiting for is refused", (await app(`/workflows/runs/${started.id}/events`, { event: "receipt.uploaded" })).status === 409);
  await call(`/api/projects/${pid}/cloud/admin`, { action: "approveRun", runId: started.id });
  r = await until(started.id, (x) => x.waiting?.type === "event");
  check("approving it in the Cloud tab moves it on to the event step", r.waiting?.type === "event" && r.steps.find((s) => s.id === "review")?.status === "approved");
  await app(`/workflows/runs/${started.id}/events`, { event: "receipt.uploaded", data: { file: "r.pdf" } });
  r = await until(started.id, (x) => x.waiting?.type === "sleep");
  check("the app's event resumes it, then it sleeps", r.waiting?.type === "sleep");
  r = await until(started.id, (x) => x.status === "completed", 90_000);
  const paid = r.steps.find((s) => s.id === "pay")?.output as { paid: number; approvedBy: string; receipt: { file: string } } | null;
  check("the scheduler wakes it and it completes with every step's output", r.status === "completed" && paid?.paid === 42 && paid.receipt.file === "r.pdf" && paid.approvedBy === "dev@localhost", JSON.stringify(paid));

  const failing = (await (await app("/workflows/refund/runs", { input: { amount: 950, email: "b@example.com" } })).json()) as { id: string };
  await until(failing.id, (x) => x.status === "waiting");
  await call(`/api/projects/${pid}/cloud/admin`, { action: "approveRun", runId: failing.id });
  await until(failing.id, (x) => x.waiting?.type === "event");
  await app(`/workflows/runs/${failing.id}/events`, { event: "receipt.uploaded", data: {} });
  r = await until(failing.id, (x) => x.status === "failed", 90_000);
  check("a failing step fails the run and says which", r.status === "failed" && /pay/.test(r.error ?? ""), r.error ?? "");
  await fs.writeFile(path.join(repo, "functions", "pay.ts"), `export default async () => ({ paid: "manually" });`);
  await call(`/api/projects/${pid}/cloud/admin`, { action: "deployFunctions" });
  await call(`/api/projects/${pid}/cloud/admin`, { action: "retryRun", runId: failing.id });
  r = await until(failing.id, (x) => x.status === "completed");
  check("retry carries on from the failed step", r.status === "completed");
  const rejected = (await (await app("/workflows/refund/runs", { input: { amount: 5, email: "c@example.com" } })).json()) as { id: string };
  await until(rejected.id, (x) => x.status === "waiting");
  await call(`/api/projects/${pid}/cloud/admin`, { action: "rejectRun", runId: rejected.id });
  check("rejecting ends the run", (await runOf(rejected.id)).status === "failed");
  const toCancel = (await (await app("/workflows/refund/runs", { input: { amount: 5, email: "d@example.com" } })).json()) as { id: string };
  await until(toCancel.id, (x) => x.status === "waiting");
  await call(`/api/projects/${pid}/cloud/admin`, { action: "cancelRun", runId: toCancel.id });
  check("runs can be cancelled", (await runOf(toCancel.id)).status === "cancelled");
  const list = (await call(`/api/projects/${pid}/cloud/admin?view=workflows`)).json as { workflows: { name: string }[]; runs: unknown[] };
  check("the Cloud tab lists workflows and runs", list.workflows[0]?.name === "refund" && list.runs.length === 4);

  // ── Custom connectors
  check("custom APIs must use https", (await call("/api/workspace/connectors", { action: "saveDef", def: { type: "api", name: "Bad", baseUrl: "http://example.com" } })).status === 400);
  check("the header must say where the key goes", (await call("/api/workspace/connectors", { action: "saveDef", def: { type: "api", name: "Bad", baseUrl: "https://example.com", headerValue: "Bearer" } })).status === 400);
  const def = await call("/api/workspace/connectors", { action: "saveDef", def: { type: "api", name: "C33 Httpbin", baseUrl: "https://httpbin.org", check: "/bearer", headerName: "Authorization", headerValue: "Bearer {{token}}", tokenLabel: "Token" } });
  defKind = def.json.def?.kind;
  const catalog = (await call("/api/workspace/connectors")).json.catalog as { kind: string; custom: boolean }[];
  check("a custom API joins the connector catalog", def.status === 201 && catalog.some((c) => c.kind === defKind && c.custom));
  const conn = await call("/api/workspace/connectors", { action: "connect", kind: defKind, values: { token: "c33-secret-token" }, scope: "workspace" });
  connId = conn.json.id;
  check("it connects once its check passes", conn.status === 201, JSON.stringify(conn.json));
  const ws = (await call("/api/workspace")).json.workspace as { id: string };
  const { connectorRequest } = await import("../src/lib/connectors");
  const res = await connectorRequest({ workspaceId: ws.id, projectId: pid, connection: "C33 Httpbin", method: "GET", path: "/headers" });
  check("the agent's requests carry the key, and the key is hidden from the answer", res.status === 200 && res.text.includes("[credential]") && !res.text.includes("c33-secret-token"));
  const escape = await connectorRequest({ workspaceId: ws.id, projectId: pid, connection: "C33 Httpbin", method: "GET", path: "https://example.com/" }).catch((e: Error) => e);
  check("requests can't leave the connector's host", escape instanceof Error && /must go to httpbin.org/.test(escape.message));
  const mcpDef = await call("/api/workspace/connectors", { action: "saveDef", def: { type: "mcp", name: "C33 Docs MCP", url: "https://mcp.example.com/mcp" } });
  check("an MCP server can be added to the registry", mcpDef.status === 201 && mcpDef.json.def.kind.startsWith("mcp-"));
  await call("/api/workspace/connectors", { action: "deleteDef", kind: mcpDef.json.def.kind });
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (connId) await call("/api/workspace/connectors", { action: "disconnect", id: connId });
  if (defKind) await call("/api/workspace/connectors", { action: "deleteDef", kind: defKind });
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
