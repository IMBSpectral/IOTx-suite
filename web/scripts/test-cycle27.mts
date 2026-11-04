/**
 * Workspace insights (JSON + CSV, formula-safe), event destinations (signed
 * deliveries of real workspace events, test sends, https only), publish check
 * hooks (deny with reason, unreachable → its setting), and agent tool
 * permissions (defaults, once / hour / always, admin-only lasting changes).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle27.mts <devToken> <usersJson>
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";

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
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any>, raw: r };
};

// A local endpoint: records deliveries; /check answers like a policy service.
const got: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let checkAnswer: unknown = { allow: false, reason: "Change freeze until Monday" };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    got.push({ path: req.url ?? "", headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/check" ? checkAnswer : { ok: true }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const ids: string[] = [];
let pid = "";

try {
  // ── Insights
  pid = ((await call("/api/projects", { name: "=HYPERLINK(\"x\") C27", force: true })).json.project as { id: string }).id;
  const ins = (await call("/api/workspace/insights")).json as { apps: { id: string; builds30d: number }[]; builders: { email: string; messages30d: number }[] };
  check("insights list apps and builders", ins.apps.some((a) => a.id === pid) && ins.builders.some((b) => b.email === "dev@localhost"));
  const csv = await (await fetchRetry(`${BASE}/api/workspace/insights?format=csv&kind=apps`, { headers: { cookie } })).text();
  check("apps export as CSV with a header row", csv.startsWith('"id","name"'));
  check("formulas in names are neutralised", csv.includes(`"'=HYPERLINK(""x"") C27"`));

  // ── Event destinations
  check("plain http endpoints are refused", (await call("/api/workspace/events", { action: "addDestination", url: "http://example.com/x", events: ["*"] })).status === 400);
  const d = await call("/api/workspace/events", { action: "addDestination", url: `http://127.0.0.1:${port}/events`, events: ["workspace.secret"] });
  ids.push(d.json.id);
  const secret = d.json.secret as string;
  check("a destination is added with a signing secret", d.status === 201 && /^whsec_/.test(secret));
  await call("/api/workspace/secrets", { action: "set", name: "C27_KEY", value: "x" });
  for (let i = 0; i < 20 && !got.some((g) => g.path === "/events"); i++) await sleep(250);
  const ev = got.find((g) => g.path === "/events");
  const parsed = ev ? (JSON.parse(ev.body) as { type: string; data: { detail: string } }) : null;
  check("a real workspace event is delivered", parsed?.type === "workspace.secret" && /C27_KEY/.test(parsed.data.detail), ev?.body.slice(0, 120));
  const expected = ev ? crypto.createHmac("sha256", secret).update(`${ev.headers["x-forge-timestamp"]}.${ev.body}`).digest("hex") : "";
  check("and signed with the destination's secret", ev?.headers["x-forge-signature"] === `sha256=${expected}`);
  got.length = 0;
  await call("/api/projects/" + pid + "/star", {});
  await sleep(800);
  check("events it didn't ask for aren't sent", !got.some((g) => g.path === "/events"));
  const t = await call("/api/workspace/events", { action: "test", id: d.json.id });
  check("a test event can be sent", t.json.status === 200);
  const listed = (await call("/api/workspace/events")).json as { destinations: { secret: string; last?: { status: number } }[]; log: unknown[] };
  check("secrets aren't listed again, deliveries are", !JSON.stringify(listed).includes(secret) && listed.log.length > 0);

  // ── Check hooks
  const h = await call("/api/workspace/events", { action: "addHook", url: `http://127.0.0.1:${port}/check`, onError: "deny" });
  ids.push(h.json.id);
  const blocked = await call(`/api/projects/${pid}/publish`, { action: "publish" });
  check("a check hook can stop a publish, with its reason", blocked.status === 403 && blocked.json.error === "Change freeze until Monday", JSON.stringify(blocked.json));
  const asked = got.find((g) => g.path === "/check");
  check("the hook is told what is being published", !!asked && JSON.parse(asked.body).data.projectId === pid);
  checkAnswer = "not json";
  const garbled = await call(`/api/projects/${pid}/publish`, { action: "publish" });
  check("a hook that answers nonsense follows its setting (stop)", garbled.status === 403);
  await call("/api/workspace/events", { action: "remove", id: h.json.id });
  const h2 = await call("/api/workspace/events", { action: "addHook", url: `http://127.0.0.1:1/check`, onError: "allow" });
  ids.push(h2.json.id);
  const through = await fetchRetry(`${BASE}/api/projects/${pid}/publish`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "check" }) });
  check("checks that aren't publishing don't ask the hook", through.status === 200);
  through.body?.cancel().catch(() => undefined);

  // ── Tool permissions
  const tp = await import("../src/lib/tool-permissions");
  check("reads run freely, writes ask", tp.defaultPref("connector", "read") === "allow" && tp.defaultPref("connector", "write") === "ask" && tp.defaultPref("mcp", "list_issues") === "allow" && tp.defaultPref("mcp", "create_issue") === "ask");
  const ws = (await call("/api/workspace")).json as { id?: string; workspace?: { id: string } };
  const wsId = ws.workspace?.id ?? ws.id ?? "";
  const key = "mcp:linear:create_issue";
  check("a write tool is held until approved", wsId !== "" && !(await tp.mayRun(wsId, key, "ask")), wsId);
  await call("/api/workspace/tool-permissions", { action: "approve", key, how: "once" });
  check("Allow once lets exactly one call through", (await tp.mayRun(wsId, key, "ask")) && !(await tp.mayRun(wsId, key, "ask")));
  await call("/api/workspace/tool-permissions", { action: "approve", key, how: "hour" });
  check("Allow for 1 hour lets calls through for now", (await tp.mayRun(wsId, key, "ask")) && (await tp.mayRun(wsId, key, "ask")));
  await call("/api/workspace/tool-permissions", { action: "approve", key, how: "deny" });
  check("Deny ends a temporary approval", !(await tp.mayRun(wsId, key, "ask")));
  await call("/api/workspace/tool-permissions", { action: "approve", key, how: "always" });
  const prefs = (await call("/api/workspace/tool-permissions")).json as { prefs: { key: string; pref: string }[] };
  check("Always allow is saved and listed", prefs.prefs.some((p) => p.key === key && p.pref === "allow") && (await tp.mayRun(wsId, key, "ask")));
  await call("/api/workspace/tool-permissions", { action: "set", key, pref: null });
  check("and can be reset to asking", !(await tp.mayRun(wsId, key, "ask")));
  check("bad keys are refused", (await call("/api/workspace/tool-permissions", { action: "approve", key: "x", how: "once" })).status === 400);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of ids) await call("/api/workspace/events", { action: "remove", id }).catch(() => undefined);
  await call("/api/workspace/secrets", { action: "delete", name: "C27_KEY" }).catch(() => undefined);
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
