/**
 * Cloud server functions and scheduled jobs: deploy from functions/, call
 * through the app API (user, secrets, console logs, custom responses), errors
 * and timeouts, the sandbox (read-only code, no host files), stats and code in
 * the Cloud tab, then jobs (bad input refused, run now, history, the scheduler
 * firing on its own, pause).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle23.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
// A reused keep-alive socket the server just closed fails once; try again.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pid = "";

const FILES: Record<string, string> = {
  "hello.ts": `import { greet } from "./_shared/greet.ts";
export default async function (req: Request, ctx: { user: { email: string } | null; trigger: string }) {
  const body = req.method === "POST" ? await req.json() : {};
  console.log("hello called", { trigger: ctx.trigger });
  return { greeting: greet(body.name ?? "world"), user: ctx.user?.email ?? null, secret: process.env.GREETING_KEY ? "set" : "missing", method: req.method };
}`,
  "_shared/greet.ts": `export const greet = (n: string): string => "Hello, " + n + "!";`,
  "created.ts": `export default () => new Response("made", { status: 201, headers: { "x-thing": "1", "content-type": "text/plain" } });`,
  "boom.ts": `export default () => { throw new Error("kaboom"); };`,
  "forever.ts": `export default async () => { while (true) {} };`,
  "snoop.ts": `import fs from "node:fs";
export default () => {
  const out: Record<string, string> = {};
  for (const p of [process.env.FORGE_FN_DIR + "/hello.ts", "/etc/hostname"]) { try { fs.readFileSync(p); out[p] = "read"; } catch { out[p] = "denied"; } }
  try { fs.writeFileSync(process.env.FORGE_FN_DIR + "/hello.ts", "x"); out.write = "wrote"; } catch { out.write = "denied"; }
  out.hostFiles = fs.existsSync("/app") || fs.existsSync("/projects") ? "visible" : "hidden";
  return out;
};`,
  "tick.ts": `export default (req: Request, ctx: { trigger: string }) => ({ ok: true, trigger: ctx.trigger });`,
};

try {
  pid = ((await call("/api/projects", { name: "C23 functions", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  await call(`/api/projects/${pid}/cloud`, { action: "setSecret", name: "GREETING_KEY", value: "s3cret-value" });
  for (const [rel, content] of Object.entries(FILES)) {
    const f = path.join(ROOT, pid, "functions", ...rel.split("/"));
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, content);
  }
  const A = `/api/projects/${pid}/cloud/admin`;
  const C = `${BASE}/cloud/v1/${pid}`;
  const fn = (name: string, init: RequestInit & { as?: string } = {}) =>
    fetch(`${C}/functions/${name}`, { ...init, headers: { apikey: anonKey, "user-agent": UA, ...(init.as ? { authorization: `Bearer ${init.as}` } : {}), ...(init.headers ?? {}) } });

  check("functions can't be called before a deploy", (await fn("hello")).status === 404);
  const dep = await call(A, { action: "deployFunctions" });
  check("deploying finds every function, but not shared code", dep.status === 201 && dep.json.names.join(",") === "boom,created,forever,hello,snoop,tick", JSON.stringify(dep.json));

  const t0 = Date.now();
  const r1 = await fn("hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ana" }) });
  const j1 = (await r1.json()) as Record<string, unknown>;
  check("a function runs and returns JSON, with shared code imported", r1.status === 200 && j1.greeting === "Hello, Ana!" && j1.method === "POST", `${JSON.stringify(j1)} in ${Date.now() - t0} ms`);
  check("secrets reach the function", j1.secret === "set");
  check("and the response is CORS-enabled for the app", r1.headers.get("access-control-allow-origin") === "*");
  const sess = (await (await fetch(`${C}/auth/signup`, { method: "POST", headers: { apikey: anonKey, "user-agent": UA, "content-type": "application/json" }, body: JSON.stringify({ email: "ana@example.com", password: "password123" }) })).json()) as { token: string };
  const t2 = Date.now();
  const j2 = (await (await fn("hello", { as: sess.token })).json()) as Record<string, unknown>;
  const warmMs = Date.now() - t2;
  check("a warm call is quick", warmMs < 1500, `${warmMs} ms`);
  check("the signed-in app user is passed in", j2.user === "ana@example.com" && j2.method === "GET");
  check("calls need the anon key", (await fetch(`${C}/functions/hello`)).status === 401);

  const r3 = await fn("created");
  check("a Response keeps its status, headers and body", r3.status === 201 && r3.headers.get("x-thing") === "1" && (await r3.text()) === "made");
  const r4 = await fn("boom");
  const j4 = (await r4.json()) as { error: string };
  check("a crashing function returns 500 with the error", r4.status === 500 && /kaboom/.test(j4.error), JSON.stringify(j4));
  check("unknown functions are 404", (await fn("nope")).status === 404);

  const snoop = (await (await fn("snoop")).json()) as Record<string, string>;
  check("the function's code is read-only and host files are out of reach", Object.entries(snoop).some(([k, v]) => k.endsWith("/hello.ts") && v === "read") && snoop.write === "denied" && snoop.hostFiles === "hidden", JSON.stringify(snoop));

  const t1 = Date.now();
  const r5 = await fn("forever");
  check("a function that never ends is stopped with a 504", r5.status === 504 && Date.now() - t1 < 60_000, `${r5.status} after ${Math.round((Date.now() - t1) / 1000)} s`);
  await sleep(3000);
  const leftover = execFileSync("C:/Program Files/Docker/Docker/resources/bin/docker.exe", ["exec", `forge-fnw-${pid}`, "sh", "-c", "ps -o args | grep '[r]unner.mjs' || true"]).toString().trim();
  check("and its process is killed", leftover === "", leftover);

  const logs = (await call(`${A}?view=fnLogs&name=hello`)).json.logs as { logs: string; trigger: string; status: number }[];
  check("console output is kept in the function's logs", logs.length === 2 && logs.every((l) => /hello called/.test(l.logs) && l.trigger === "http"));
  check("secret values never appear in logs", !JSON.stringify((await call(`${A}?view=fnLogs`)).json).includes("s3cret-value"));
  const errs = (await call(`${A}?view=fnLogs&errors=1`)).json.logs as { name: string }[];
  check("the log can show failures only", errs.length === 2 && errs.every((e) => e.name === "boom" || e.name === "forever"));
  const stats = (await call(`${A}?view=functions`)).json as { functions: { name: string; calls: number; errors: number; perDay: { calls: number }[] }[] };
  const hello = stats.functions.find((f) => f.name === "hello")!;
  check("the Cloud tab shows calls, errors and a 7-day chart", hello.calls === 2 && hello.errors === 0 && hello.perDay.length === 7 && hello.perDay[6].calls === 2, JSON.stringify(hello));
  const src = (await call(`${A}?view=fnSource&name=hello`)).json.source as string;
  check("and the deployed code", /greet\(/.test(src));
  const test = (await call(A, { action: "invokeFunction", name: "hello", body: JSON.stringify({ name: "Test" }) })).json;
  check("a test run from the Cloud tab works", test.status === 200 && /Hello, Test!/.test(test.body), JSON.stringify(test));

  // Jobs
  check("a job needs a real function", (await call(A, { action: "createJob", name: "x", fn: "missing", schedule: "0 9 * * *" })).status === 400);
  check("and a valid schedule", (await call(A, { action: "createJob", name: "x", fn: "tick", schedule: "99 * * * *" })).status === 400);
  const job = (await call(A, { action: "createJob", name: "Every minute", fn: "tick", schedule: "* * * * *", timezone: "UTC" })).json as { id: string; nextRunAt: string };
  check("a job is created with its next run", !!job.id && new Date(job.nextRunAt) > new Date());
  const now = (await call(A, { action: "runJob", jobId: job.id })).json as { status: number; body: string };
  check("Run now calls the function as a job", now.status === 200 && /"trigger":"job"/.test(now.body), JSON.stringify(now));
  let fired = false;
  for (let i = 0; i < 20 && !fired; i++) {
    await sleep(6000);
    const runs = (await call(`${A}?view=jobRuns&job=${job.id}`)).json.runs as unknown[];
    fired = runs.length >= 2;
  }
  check("the scheduler runs the job on its own", fired);
  const summary = ((await call(`${A}?view=jobs`)).json.jobs as { id: string; runs30d: number; description: string; lastStatus: number }[])[0];
  check("jobs show runs, run time and a readable schedule", summary.runs30d >= 2 && summary.lastStatus === 200 && summary.description === "Cron: * * * * *", JSON.stringify(summary));
  const off = (await call(A, { action: "updateJob", jobId: job.id, enabled: false })).json as { enabled: boolean };
  check("a job can be paused", off.enabled === false);
  const before = ((await call(`${A}?view=jobRuns&job=${job.id}`)).json.runs as unknown[]).length;
  await sleep(70_000);
  const after = ((await call(`${A}?view=jobRuns&job=${job.id}`)).json.runs as unknown[]).length;
  check("and a paused job doesn't run", after === before, `${before} → ${after}`);
  await call(A, { action: "deleteJob", jobId: job.id });
  check("jobs can be deleted", ((await call(`${A}?view=jobs`)).json.jobs as unknown[]).length === 0);

  const outsider = `authjs.session-token=${users["outsider@localhost"]}`;
  const o = (await call(A, { action: "deployFunctions" }, outsider)).status;
  check("people without edit access can't deploy", o === 403 || o === 404);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
