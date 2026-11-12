import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { CloudError, cloudDir, cloudUrl, getCloud, inheritedSecretNames, openDatabase, readSecret, updateCloud, type CloudConfig } from "./cloud";
import { charge } from "./credits";
import { PROJECTS_ROOT, repoDir } from "./paths";
import { docker } from "./sandbox";

/**
 * Forge Cloud server functions (Lovable's edge functions): TypeScript files at
 * functions/<name>.ts in the app, each exporting a default handler
 *   export default async function (req: Request, ctx) { return Response.json(...) }
 * that runs on the server with the project's secrets in process.env. Use them
 * for anything that must not run in the browser: payment and AI APIs with
 * secret keys, webhooks, scheduled jobs.
 *
 * A deploy snapshots the folder. Each project has one warm, locked-down
 * container (no host access, read-only code, memory/CPU/process limits) that
 * is removed after it sits idle; every call is a fresh Node process in it,
 * killed after 30 s, and logged with its console output. Run time is billed
 * per project.
 */

const IMAGE = process.env.SANDBOX_IMAGE ?? "node:22-alpine";
const TIMEOUT_MS = Number(process.env.FORGE_FN_TIMEOUT_MS ?? 30_000);
const SECONDS_PER_CREDIT = Number(process.env.FORGE_FN_SECONDS_PER_CREDIT ?? 600);
const MAX_BODY = 6 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-_]{0,62}$/;
const KEEP_DEPLOYS = 5;
const RESULT = "__FORGE_RESULT__";

export type FunctionsState = {
  deployId: string;
  deployedAt: string;
  names: string[];
  history: { deployId: string; deployedAt: string; names: string[] }[];
  /** Run time not yet billed, in ms. */
  unbilledMs?: number;
};

export type Invocation = {
  at: string;
  name: string;
  trigger: "http" | "job" | "test";
  status: number;
  ms: number;
  error: string | null;
  logs: string;
};

const fnRoot = (projectId: string) => path.join(cloudDir(projectId), "functions");
const deployDir = (projectId: string, deployId: string) => path.join(fnRoot(projectId), "deploys", deployId);
const runtimeDir = path.join(PROJECTS_ROOT, "_cloud", "_runtime");

// The runner inside the container: load the request, set the environment,
// call the handler, print the result after a marker (console output before it).
const RUNNER = `import fs from "node:fs";
const req = JSON.parse(fs.readFileSync("/functions/requests/" + process.env.FORGE_REQ, "utf8"));
Object.assign(process.env, req.env);
const logs = [];
for (const k of ["log", "info", "warn", "error", "debug"]) {
  console[k] = (...a) => { if (logs.length < 200) logs.push("[" + k + "] " + a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ").slice(0, 2000)); };
}
let out;
try {
  const mod = await import(process.env.FORGE_FN_DIR + "/" + req.name + ".ts");
  const handler = mod.default ?? mod.handler;
  if (typeof handler !== "function") throw new Error("functions/" + req.name + ".ts must export a default function");
  const body = req.body == null || req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(req.body, "base64");
  const request = new Request(req.url, { method: req.method, headers: req.headers, body });
  let res = await handler(request, { user: req.user, trigger: req.trigger, env: process.env });
  if (!(res instanceof Response)) res = Response.json(res === undefined ? null : res);
  const buf = Buffer.from(await res.arrayBuffer());
  out = { status: res.status, headers: Object.fromEntries(res.headers), body: buf.toString("base64") };
} catch (e) {
  out = { error: String((e && e.stack) || e).slice(0, 4000) };
}
out.logs = logs;
process.stdout.write("\\n${RESULT}" + JSON.stringify(out) + "\\n");
process.exit(0);
`;

async function runnerFile() {
  const file = path.join(runtimeDir, "runner.mjs");
  const current = await fs.readFile(file, "utf8").catch(() => "");
  if (current !== RUNNER) {
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(file, RUNNER);
  }
  return file;
}

export function functionsState(cfg: CloudConfig): FunctionsState | null {
  return (cfg as CloudConfig & { functions?: FunctionsState }).functions ?? null;
}

// ── Source and deploys ────────────────────────────────────────────────────

/** functions/*.ts in the app's working tree (shared code may sit in functions/_shared/). */
async function sourceFiles(projectId: string) {
  const root = path.join(repoDir(projectId), "functions");
  const out: { rel: string; content: string }[] = [];
  async function walk(dir: string, rel: string, depth: number) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) await walk(path.join(dir, e.name), r, depth + 1);
      else if (e.isFile() && /\.(ts|js|mjs|json)$/.test(e.name)) out.push({ rel: r, content: await fs.readFile(path.join(dir, e.name), "utf8") });
    }
  }
  await walk(root, "", 0);
  return out;
}

const functionNames = (files: { rel: string }[]) =>
  files
    .map((f) => f.rel)
    .filter((r) => !r.includes("/") && r.endsWith(".ts") && !r.startsWith("_"))
    .map((r) => r.replace(/\.ts$/, ""))
    .filter((n) => NAME.test(n))
    .sort();

/** Function names deployed or waiting in the working tree. */
export async function knownFunctionNames(projectId: string, cfg: CloudConfig) {
  return [...new Set([...(functionsState(cfg)?.names ?? []), ...functionNames(await sourceFiles(projectId))])];
}

/** Snapshot functions/ as a new deploy. Returns the deployed function names. */
export async function deployFunctions(projectId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  const files = await sourceFiles(projectId);
  const names = functionNames(files);
  const deployId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = deployDir(projectId, deployId);
  for (const f of files) {
    const target = path.join(dir, ...f.rel.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content);
  }
  await fs.mkdir(dir, { recursive: true });
  let dropped: string[] = [];
  await updateCloud(projectId, (c) => {
    const prev = functionsState(c);
    const history = [{ deployId, deployedAt: new Date().toISOString(), names }, ...(prev?.history ?? [])];
    dropped = history.slice(KEEP_DEPLOYS).map((h) => h.deployId);
    (c as CloudConfig & { functions?: FunctionsState }).functions = {
      deployId,
      deployedAt: history[0].deployedAt,
      names,
      history: history.slice(0, KEEP_DEPLOYS),
      unbilledMs: prev?.unbilledMs ?? 0,
    };
  });
  for (const d of dropped) await fs.rm(deployDir(projectId, d), { recursive: true, force: true });
  return { deployId, names };
}

/** Deploy only when functions/ changed since the last deploy (after a build). */
export async function deployIfChanged(projectId: string) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) return null;
  const files = await sourceFiles(projectId);
  const state = functionsState(cfg);
  if (!files.length && !state) return null;
  if (state) {
    const live = await sourceFilesAt(deployDir(projectId, state.deployId));
    const same = live.length === files.length && files.every((f) => live.find((l) => l.rel === f.rel)?.content === f.content);
    if (same) return null;
  }
  return deployFunctions(projectId);
}

async function sourceFilesAt(dir: string) {
  const out: { rel: string; content: string }[] = [];
  async function walk(d: string, rel: string) {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else out.push({ rel: r, content: await fs.readFile(path.join(d, e.name), "utf8") });
    }
  }
  await walk(dir, "");
  return out;
}

/** The deployed source of one function (Cloud tab → View code). */
export async function functionSource(projectId: string, name: string) {
  const cfg = await getCloud(projectId);
  const state = cfg && functionsState(cfg);
  if (!state || !state.names.includes(name)) throw new CloudError("Function not found", 404);
  return fs.readFile(path.join(deployDir(projectId, state.deployId), `${name}.ts`), "utf8");
}

// ── Invoking ──────────────────────────────────────────────────────────────

async function logTable(projectId: string) {
  const db = openDatabase(projectId);
  await db.ensure(`CREATE TABLE IF NOT EXISTS _forge_fn_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, name TEXT NOT NULL, trigger TEXT NOT NULL,
    status INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT, logs TEXT NOT NULL DEFAULT '')`);
  return db;
}

async function record(projectId: string, e: Invocation) {
  const t = await logTable(projectId);
  await t.run("INSERT INTO _forge_fn_logs (at, name, trigger, status, ms, error, logs) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    e.at,
    e.name,
    e.trigger,
    e.status,
    e.ms,
    e.error,
    e.logs.slice(0, 20_000),
  ]);
  await t.run("DELETE FROM _forge_fn_logs WHERE id <= (SELECT MAX(id) - 2000 FROM _forge_fn_logs)");
}

/** Add run time and bill whole credits as they accrue. */
async function bill(projectId: string, ms: number) {
  let credits = 0;
  await updateCloud(projectId, (c) => {
    const s = functionsState(c);
    if (!s) return;
    const total = (s.unbilledMs ?? 0) + ms;
    credits = Math.floor(total / (SECONDS_PER_CREDIT * 1000));
    s.unbilledMs = total - credits * SECONDS_PER_CREDIT * 1000;
  }).catch(() => undefined);
  if (credits > 0) {
    const p = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
    if (p) await charge(p.workspaceId, credits, "GENERATION", undefined, { category: "cloud", projectId });
  }
}

const IDLE_MS = Number(process.env.FORGE_FN_IDLE_MS ?? 10 * 60_000);
const warmName = (projectId: string) => `forge-fnw-${projectId}`;
const warm = new Map<string, Promise<void>>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Start (or find) the project's function container. */
function ensureWarm(projectId: string) {
  let p = warm.get(projectId);
  if (!p) {
    p = (async () => {
      const name = warmName(projectId);
      const st = await docker(["inspect", "-f", "{{.State.Running}} {{.HostConfig.Init}}", name], 20_000);
      // Reused only when running and started with --init; older containers are replaced.
      if (st.code === 0 && st.out.trim() === "true true") return;
      if (st.code === 0) await docker(["rm", "-f", name], 20_000);
      await fs.mkdir(fnRoot(projectId), { recursive: true });
      const r = await docker(
        [
          // --init: a tiny init as PID 1 reaps finished calls. Without it every call left a zombie
          // behind (tail never reaps), and at the pids limit no call could start (OCI "procReady not received").
          "run", "-d", "--init", "--name", name, "--label", "forge.fn=1",
          "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
          "--read-only", "--tmpfs", "/tmp:size=32m",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "node",
          "-v", `${fnRoot(projectId)}:/functions:ro`,
          "-v", `${await runnerFile()}:/runner.mjs:ro`,
          IMAGE, "tail", "-f", "/dev/null",
        ],
        60_000,
      );
      if (r.code !== 0) throw new CloudError(`Server functions couldn't start: ${r.out.trim().slice(0, 300)}`, 503);
    })();
    warm.set(projectId, p);
    p.catch(() => warm.delete(projectId));
  }
  return p;
}

function touchWarm(projectId: string) {
  clearTimeout(idleTimers.get(projectId));
  idleTimers.set(
    projectId,
    setTimeout(() => {
      idleTimers.delete(projectId);
      warm.delete(projectId);
      void docker(["rm", "-f", warmName(projectId)], 30_000);
    }, IDLE_MS),
  );
}

/** Remove the project's function container now (project deleted). */
export async function stopFunctions(projectId: string) {
  clearTimeout(idleTimers.get(projectId));
  idleTimers.delete(projectId);
  warm.delete(projectId);
  await docker(["rm", "-f", warmName(projectId)], 30_000);
}

/** Remove function containers left over from before a restart. */
export async function sweepFunctionContainers() {
  const r = await docker(["ps", "-aq", "--filter", "label=forge.fn=1"], 20_000);
  const ids = r.out.split(/s+/).filter(Boolean);
  if (r.code === 0 && ids.length) await docker(["rm", "-f", ...ids], 60_000);
}

const running = new Map<string, number>();
const MAX_CONCURRENT = Number(process.env.FORGE_FN_CONCURRENCY ?? 4);

/**
 * Run a deployed function. Returns its Response parts; errors in the user's
 * code come back as a 500 with the error text, never as a thrown exception.
 */
export async function invokeFunction(
  projectId: string,
  cfg: CloudConfig,
  name: string,
  req: { method: string; url: string; headers: Record<string, string>; body: Uint8Array | null },
  user: { id: string; email: string } | null,
  trigger: Invocation["trigger"],
  opts: { dir?: string } = {},
) {
  const state = functionsState(cfg);
  if (!opts.dir && !state?.names.includes(name)) throw new CloudError(`There is no deployed function called ${name}.`, 404);
  if (req.body && req.body.byteLength > MAX_BODY) throw new CloudError("Request body too large.", 413);
  if ((running.get(projectId) ?? 0) >= MAX_CONCURRENT) throw new CloudError("Too many function calls at once. Try again shortly.", 429);
  running.set(projectId, (running.get(projectId) ?? 0) + 1);

  const env: Record<string, string> = {
    FORGE_CLOUD_URL: cloudUrl(projectId),
    FORGE_ANON_KEY: cfg.anonKey,
  };
  for (const s of [...Object.keys(cfg.secrets ?? {}), ...(await inheritedSecretNames(projectId))]) {
    const v = await readSecret(projectId, s).catch(() => null);
    if (v !== null && v !== undefined) env[s] = v;
  }
  const reqDir = path.join(fnRoot(projectId), "requests");
  await fs.mkdir(reqDir, { recursive: true });
  const reqName = `${crypto.randomUUID()}.json`;
  await fs.writeFile(
    path.join(reqDir, reqName),
    JSON.stringify({ name, method: req.method, url: req.url, headers: req.headers, body: req.body ? Buffer.from(req.body).toString("base64") : null, user, trigger, env }),
  );
  // Code is found by its folder under functions/ (a deploy, or a test copy).
  const codeDir = path.relative(fnRoot(projectId), opts.dir ?? deployDir(projectId, state!.deployId)).split(path.sep).join("/");
  const exec = () =>
    docker(
      [
        "exec", "-u", "node",
        "-e", `FORGE_REQ=${reqName}`,
        "-e", `FORGE_FN_DIR=/functions/${codeDir}`,
        warmName(projectId),
        "timeout", "-s", "KILL", String(Math.ceil(TIMEOUT_MS / 1000)),
        "node", "--disable-warning=ExperimentalWarning", "/runner.mjs",
      ],
      TIMEOUT_MS + 15_000,
    );
  let started = Date.now();
  let r: { code: number; out: string };
  try {
    await ensureWarm(projectId);
    started = Date.now();
    r = await exec();
    // The container went away (idle removal, Docker restart): start it again once.
    // A container that can no longer start processes (OCI runtime exec failed) is replaced too.
    if (r.code !== 0 && /No such container|is not running|OCI runtime exec failed/i.test(r.out)) {
      if (/OCI runtime/i.test(r.out)) await docker(["rm", "-f", warmName(projectId)], 30_000);
      warm.delete(projectId);
      await ensureWarm(projectId);
      started = Date.now();
      r = await exec();
    }
    touchWarm(projectId);
  } finally {
    // Secrets were in the request file; it goes as soon as the run ends.
    await fs.rm(path.join(reqDir, reqName), { force: true });
    running.set(projectId, Math.max(0, (running.get(projectId) ?? 1) - 1));
  }
  const ms = Date.now() - started;
  // Killed by the in-container timeout (137), or the CLI itself gave up.
  const timedOut = r.code === -1 || (r.code === 137 && !r.out.includes(RESULT));

  const at = r.out.lastIndexOf(RESULT);
  let parsed: { status?: number; headers?: Record<string, string>; body?: string; error?: string; logs?: string[] } = {};
  if (at >= 0) {
    try {
      parsed = JSON.parse(r.out.slice(at + RESULT.length).trim().split("\n")[0]);
    } catch {
      parsed = { error: "The function's output couldn't be read." };
    }
  } else {
    parsed = { error: timedOut ? `Timed out after ${TIMEOUT_MS / 1000} seconds.` : r.out.trim().slice(-2000) || "The function crashed." };
  }
  const status = parsed.error ? (timedOut ? 504 : 500) : (parsed.status ?? 200);
  await record(projectId, {
    at: new Date().toISOString(),
    name,
    trigger,
    status,
    ms,
    error: parsed.error ?? null,
    logs: (parsed.logs ?? []).join("\n"),
  });
  void bill(projectId, ms);
  if (parsed.error) {
    return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: parsed.error.split("\n")[0] })) };
  }
  return {
    status,
    headers: parsed.headers ?? {},
    body: Buffer.from(parsed.body ?? "", "base64"),
  };
}

/**
 * Run a function from the working tree without deploying it (the agent's
 * test while building, which may be in a draft the live app must not see).
 */
export async function testFunction(projectId: string, name: string, method = "POST", body = "{}") {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  const files = await sourceFiles(projectId);
  if (!functionNames(files).includes(name)) throw new CloudError(`There is no functions/${name}.ts.`, 404);
  const dir = path.join(fnRoot(projectId), "tests", crypto.randomUUID());
  for (const f of files) {
    const target = path.join(dir, ...f.rel.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content);
  }
  try {
    const res = await invokeFunction(
      projectId,
      cfg,
      name,
      { method, url: `${cloudUrl(projectId)}/functions/${name}`, headers: { "content-type": "application/json" }, body: method === "GET" ? null : Buffer.from(body) },
      null,
      "test",
      { dir },
    );
    const logs = (await readInvocations(projectId, { name, limit: 1 }))[0]?.logs ?? "";
    return { status: res.status, body: res.body.toString("utf8").slice(0, 8000), logs: logs.slice(0, 4000) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Cloud tab ─────────────────────────────────────────────────────────────

export async function readInvocations(projectId: string, { name = "", errorsOnly = false, limit = 200 } = {}) {
  const where: string[] = [];
  const args: string[] = [];
  if (name) {
    where.push("name = ?");
    args.push(name);
  }
  if (errorsOnly) where.push("status >= 400");
  return (await logTable(projectId)).all<Invocation>(
    `SELECT at, name, trigger, status, ms, error, logs FROM _forge_fn_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    [...args, Math.min(1000, limit)],
  );
}

/** Per function: calls, errors and average time in the last 7 days, plus calls per day. */
export async function functionStats(projectId: string, names: string[]) {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await (await logTable(projectId)).all<{ name: string; day: string; calls: number; errors: number; avg: number }>(
    "SELECT name, substr(at, 1, 10) AS day, COUNT(*) AS calls, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors, AVG(ms) AS avg FROM _forge_fn_logs WHERE at >= ? GROUP BY name, substr(at, 1, 10)",
    [since],
  );
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
  return names.map((n) => {
    const mine = rows.filter((r) => r.name === n);
    const calls = mine.reduce((s, r) => s + Number(r.calls), 0);
    return {
      name: n,
      calls,
      errors: mine.reduce((s, r) => s + Number(r.errors), 0),
      avgMs: calls ? Math.round(mine.reduce((s, r) => s + Number(r.avg) * Number(r.calls), 0) / calls) : 0,
      perDay: days.map((d) => ({ day: d, calls: Number(mine.find((r) => r.day === d)?.calls ?? 0) })),
    };
  });
}
