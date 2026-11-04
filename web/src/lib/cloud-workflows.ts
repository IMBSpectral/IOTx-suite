import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CloudError, cloudUrl, getCloud, openDatabase, type CloudConfig } from "./cloud";
import { invokeFunction } from "./cloud-functions";
import { hasLive } from "./cloud-envs";
import { PROJECTS_ROOT, repoDir } from "./paths";

/**
 * Durable workflows for the app (Cloud tab → Workflows). A workflow is a
 * JSON file in the app, workflows/<name>.json:
 *
 *   { "input": { "type": "object", "required": ["email"], "properties": { "email": { "type": "string" } } },
 *     "steps": [
 *       { "id": "welcome", "type": "function", "function": "send-welcome" },
 *       { "id": "review",  "type": "approval", "message": "Approve this refund?" },
 *       { "id": "paid",    "type": "event", "event": "payment.confirmed", "timeoutHours": 24 },
 *       { "id": "pause",   "type": "sleep", "seconds": 60 } ] }
 *
 * Runs keep their state in the app's database, so they survive restarts: a
 * step that waits (approval, event, sleep) parks the run, and an approval, an
 * event sent to the run, or the scheduler moves it on. Function steps call a
 * server function with { input, steps } (earlier steps' outputs).
 */

type Step =
  | { id: string; type: "function"; function: string }
  | { id: string; type: "approval"; message?: string }
  | { id: string; type: "event"; event: string; timeoutHours?: number }
  | { id: string; type: "sleep"; seconds: number };
export type Workflow = { name: string; input?: Schema; steps: Step[] };
type Schema = { type?: string; required?: string[]; properties?: Record<string, Schema>; enum?: unknown[]; items?: Schema };

export type Run = {
  id: string;
  workflow: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  input: unknown;
  step: number;
  outputs: Record<string, unknown>;
  waiting: { type: "approval" | "event" | "sleep"; event?: string; until?: string; message?: string } | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
type StepRow = { run_id: string; step_id: string; status: string; output: string | null; error: string | null; started_at: string; finished_at: string | null };

export class WorkflowError extends CloudError {}

const NAME = /^[a-z0-9][a-z0-9-_]{0,62}$/;

// ── Definitions ───────────────────────────────────────────────────────────

function validateDef(name: string, raw: unknown): Workflow {
  const o = (raw ?? {}) as { input?: Schema; steps?: unknown[] };
  if (!Array.isArray(o.steps) || !o.steps.length) throw new WorkflowError(`workflows/${name}.json needs a list of steps.`);
  const ids = new Set<string>();
  const steps = o.steps.map((s, i) => {
    const st = (s ?? {}) as Record<string, unknown>;
    const id = typeof st.id === "string" && st.id ? st.id : `step-${i + 1}`;
    if (ids.has(id)) throw new WorkflowError(`${name}: two steps are called ${id}.`);
    ids.add(id);
    switch (st.type) {
      case "function":
        if (typeof st.function !== "string") throw new WorkflowError(`${name}/${id}: say which function to call.`);
        return { id, type: "function", function: st.function } as Step;
      case "approval":
        return { id, type: "approval", message: typeof st.message === "string" ? st.message.slice(0, 300) : undefined } as Step;
      case "event":
        if (typeof st.event !== "string") throw new WorkflowError(`${name}/${id}: say which event to wait for.`);
        return { id, type: "event", event: st.event, timeoutHours: typeof st.timeoutHours === "number" ? st.timeoutHours : undefined } as Step;
      case "sleep":
        if (typeof st.seconds !== "number" || st.seconds < 1) throw new WorkflowError(`${name}/${id}: sleep needs seconds.`);
        return { id, type: "sleep", seconds: Math.min(st.seconds, 30 * 86400) } as Step;
      default:
        throw new WorkflowError(`${name}/${id}: the step type is function, approval, event or sleep.`);
    }
  });
  return { name, input: o.input, steps };
}

export async function listWorkflows(projectId: string): Promise<Workflow[]> {
  const dir = path.join(repoDir(projectId.split("@")[0]), "workflows");
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const out: Workflow[] = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    if (!NAME.test(name)) continue;
    try {
      out.push(validateDef(name, JSON.parse(await fs.readFile(path.join(dir, f), "utf8"))));
    } catch {
      // A broken definition is reported when someone tries to start it.
    }
  }
  return out;
}

async function workflow(projectId: string, name: string) {
  if (!NAME.test(name)) throw new WorkflowError("Unknown workflow", 404);
  const raw = await fs.readFile(path.join(repoDir(projectId.split("@")[0]), "workflows", `${name}.json`), "utf8").catch(() => null);
  if (raw === null) throw new WorkflowError(`There is no workflow called ${name}.`, 404);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new WorkflowError(`workflows/${name}.json isn't valid JSON.`);
  }
  return validateDef(name, json);
}

/** Check a value against the small JSON Schema subset workflows use. */
export function checkSchema(schema: Schema | undefined, value: unknown, at = "input"): string | null {
  if (!schema) return null;
  const t = schema.type;
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value === "number" && Number.isInteger(value) && t === "integer" ? "integer" : typeof value;
  if (t && t !== actual && !(t === "number" && actual === "integer")) return `${at} should be ${t === "object" ? "an object" : `a ${t}`}.`;
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.map(String).join(", ")}.`;
  if (t === "object" && value && typeof value === "object") {
    for (const k of schema.required ?? []) if (!(k in (value as object))) return `${at}.${k} is required.`;
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (k in (value as object)) {
        const e = checkSchema(s, (value as Record<string, unknown>)[k], `${at}.${k}`);
        if (e) return e;
      }
    }
  }
  if (t === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const e = checkSchema(schema.items, value[i], `${at}[${i}]`);
      if (e) return e;
    }
  }
  return null;
}

// ── Runs ──────────────────────────────────────────────────────────────────

async function tables(dataId: string) {
  const db = openDatabase(dataId);
  await db.ensure(`CREATE TABLE IF NOT EXISTS _forge_workflow_runs (
      id TEXT PRIMARY KEY, workflow TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
      outputs TEXT NOT NULL DEFAULT '{}', waiting TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS _forge_workflow_steps (
      run_id TEXT NOT NULL, step_id TEXT NOT NULL, status TEXT NOT NULL, output TEXT, error TEXT,
      started_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY (run_id, step_id));`);
  return db;
}

function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: String(r.id),
    workflow: String(r.workflow),
    status: r.status as Run["status"],
    input: JSON.parse(String(r.input)),
    step: Number(r.step),
    outputs: JSON.parse(String(r.outputs)),
    waiting: r.waiting ? JSON.parse(String(r.waiting)) : null,
    error: (r.error as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

async function getRow(dataId: string, id: string) {
  return (await tables(dataId)).get<Record<string, unknown>>("SELECT * FROM _forge_workflow_runs WHERE id = ?", [id]);
}

export async function getRun(dataId: string, id: string) {
  const r = await getRow(dataId, id);
  if (!r) throw new WorkflowError("Run not found", 404);
  const steps = await (await tables(dataId)).all<StepRow>("SELECT * FROM _forge_workflow_steps WHERE run_id = ? ORDER BY started_at", [id]);
  return { ...rowToRun(r), steps: steps.map((s) => ({ id: s.step_id, status: s.status, output: s.output ? JSON.parse(s.output) : null, error: s.error, startedAt: s.started_at, finishedAt: s.finished_at })) };
}

export async function listRuns(dataId: string, workflowName?: string) {
  const rows = await (await tables(dataId)).all<Record<string, unknown>>(
    `SELECT * FROM _forge_workflow_runs ${workflowName ? "WHERE workflow = ?" : ""} ORDER BY created_at DESC LIMIT 100`,
    workflowName ? [workflowName] : [],
  );
  return rows.map(rowToRun);
}

async function save(dataId: string, run: Run) {
  await (await tables(dataId)).run("UPDATE _forge_workflow_runs SET status = ?, step = ?, outputs = ?, waiting = ?, error = ?, updated_at = ? WHERE id = ?", [
    run.status,
    run.step,
    JSON.stringify(run.outputs),
    run.waiting ? JSON.stringify(run.waiting) : null,
    run.error,
    new Date().toISOString(),
    run.id,
  ]);
}

async function stepStatus(dataId: string, runId: string, stepId: string, status: string, output?: unknown, error?: string | null) {
  const now = new Date().toISOString();
  await (await tables(dataId)).run(
      `INSERT INTO _forge_workflow_steps (run_id, step_id, status, output, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, step_id) DO UPDATE SET status = excluded.status, output = excluded.output, error = excluded.error,
         finished_at = excluded.finished_at`,
    [runId, stepId, status, output === undefined ? null : JSON.stringify(output), error ?? null, now, ["completed", "failed", "approved", "rejected", "skipped"].includes(status) ? now : null],
  );
}

const advancing = new Set<string>();

/** Run steps until the workflow finishes, fails, or has to wait. */
async function advance(projectId: string, dataId: string, runId: string) {
  const key = `${dataId}:${runId}`;
  if (advancing.has(key)) return;
  advancing.add(key);
  try {
    const cfg = await getCloud(projectId);
    if (!cfg) return;
    let run = rowToRun((await getRow(dataId, runId)) as Record<string, unknown>);
    const wf = await workflow(projectId, run.workflow);
    while (run.status === "running" && run.step < wf.steps.length) {
      const step = wf.steps[run.step];
      if (step.type === "function") {
        await stepStatus(dataId, run.id, step.id, "running");
        await save(dataId, run);
        const res = await invokeFunction(
          projectId,
          cfg as CloudConfig,
          step.function,
          { method: "POST", url: `${cloudUrl(projectId)}/functions/${step.function}`, headers: { "content-type": "application/json", "x-forge-workflow-run": run.id }, body: Buffer.from(JSON.stringify({ input: run.input, steps: run.outputs, runId: run.id })) },
          null,
          "job",
        ).catch((e: Error) => ({ status: 500, headers: {}, body: Buffer.from(JSON.stringify({ error: e.message })) }));
        const text = res.body.toString("utf8");
        let out: unknown = text;
        try {
          out = JSON.parse(text);
        } catch {}
        if (res.status >= 400) {
          await stepStatus(dataId, run.id, step.id, "failed", out, `The function answered ${res.status}.`);
          run = { ...run, status: "failed", error: `Step ${step.id} failed (${res.status}).` };
          await save(dataId, run);
          return;
        }
        await stepStatus(dataId, run.id, step.id, "completed", out);
        run = { ...run, outputs: { ...run.outputs, [step.id]: out }, step: run.step + 1 };
        await save(dataId, run);
        continue;
      }
      // Waiting steps park the run.
      const waiting: Run["waiting"] =
        step.type === "approval"
          ? { type: "approval", message: step.message }
          : step.type === "event"
            ? { type: "event", event: step.event, until: step.timeoutHours ? new Date(Date.now() + step.timeoutHours * 3600_000).toISOString() : undefined }
            : { type: "sleep", until: new Date(Date.now() + step.seconds * 1000).toISOString() };
      await stepStatus(dataId, run.id, step.id, "waiting");
      run = { ...run, status: "waiting", waiting };
      await save(dataId, run);
      return;
    }
    if (run.status === "running") {
      run = { ...run, status: "completed", waiting: null };
      await save(dataId, run);
    }
  } finally {
    advancing.delete(key);
  }
}

/** Start a run; the input is checked against the workflow's schema first. */
export async function startRun(projectId: string, dataId: string, name: string, input: unknown) {
  const wf = await workflow(projectId, name);
  const problem = checkSchema(wf.input, input ?? {});
  if (problem) throw new WorkflowError(`The input doesn't fit the workflow: ${problem}`);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await (await tables(dataId)).run(
    "INSERT INTO _forge_workflow_runs (id, workflow, status, input, step, outputs, created_at, updated_at) VALUES (?, ?, 'running', ?, 0, '{}', ?, ?)",
    [id, name, JSON.stringify(input ?? {}), now, now],
  );
  void advance(projectId, dataId, id).catch((e) => console.error("[workflows]", e));
  return { id, status: "running" as const };
}

/** Move a parked step on (approval decided, event arrived, sleep over) and keep going. */
function resume(projectId: string, dataId: string, run: Run, output: unknown, status = "completed") {
  const wfStep = run.step;
  void (async () => {
    const wf = await workflow(projectId, run.workflow);
    const step = wf.steps[wfStep];
    await stepStatus(dataId, run.id, step.id, status, output);
    await save(dataId, { ...run, status: "running", waiting: null, step: wfStep + 1, outputs: { ...run.outputs, [step.id]: output } });
    await advance(projectId, dataId, run.id);
  })().catch((e) => console.error("[workflows]", e));
}

export async function decide(projectId: string, dataId: string, runId: string, approve: boolean, by: string) {
  const run = rowToRun((await getRow(dataId, runId)) as Record<string, unknown>);
  if (run.status !== "waiting" || run.waiting?.type !== "approval") throw new WorkflowError("This run isn't waiting for an approval.", 409);
  if (approve) return resume(projectId, dataId, run, { approved: true, by }, "approved");
  const wf = await workflow(projectId, run.workflow);
  await stepStatus(dataId, run.id, wf.steps[run.step].id, "rejected", { approved: false, by });
  await save(dataId, { ...run, status: "failed", waiting: null, error: `Rejected by ${by}.` });
}

/** An event sent to a run (from the app, a function or the Cloud tab). */
export async function sendEvent(projectId: string, dataId: string, runId: string, event: string, data: unknown) {
  const raw = await getRow(dataId, runId);
  if (!raw) throw new WorkflowError("Run not found", 404);
  const run = rowToRun(raw);
  if (run.status !== "waiting" || run.waiting?.type !== "event" || run.waiting.event !== event) {
    throw new WorkflowError(`This run isn't waiting for "${event}".`, 409);
  }
  resume(projectId, dataId, run, { event, data: data ?? null });
  return { ok: true };
}

export async function cancelRun(dataId: string, runId: string) {
  const run = rowToRun((await getRow(dataId, runId)) as Record<string, unknown>);
  if (run.status === "completed" || run.status === "cancelled") throw new WorkflowError("This run has already ended.", 409);
  await save(dataId, { ...run, status: "cancelled", waiting: null });
}

/** Retry a failed run from the step that failed. */
export async function retryRun(projectId: string, dataId: string, runId: string) {
  const run = rowToRun((await getRow(dataId, runId)) as Record<string, unknown>);
  if (run.status !== "failed") throw new WorkflowError("Only failed runs can be retried.", 409);
  await save(dataId, { ...run, status: "running", error: null, waiting: null });
  void advance(projectId, dataId, runId).catch((e) => console.error("[workflows]", e));
}

// ── Scheduler: wake sleeping runs, time out events, pick up runs interrupted by a restart ──

export async function tickWorkflows(now = new Date()) {
  const root = path.join(PROJECTS_ROOT, "_cloud");
  for (const projectId of (await fs.readdir(root).catch(() => [] as string[])).filter((d) => !d.startsWith("_"))) {
    const cfg = await getCloud(projectId).catch(() => null);
    if (!cfg?.enabled || cfg.paused) continue;
    const dataIds = [projectId, `${projectId}@live`];
    for (const dataId of dataIds) {
      if (dataId.endsWith("@live") && !(await hasLive(projectId))) continue;
      let rows: Record<string, unknown>[];
      try {
        rows = await (await tables(dataId)).all<Record<string, unknown>>("SELECT * FROM _forge_workflow_runs WHERE status IN ('waiting', 'running')");
      } catch {
        continue;
      }
      for (const r of rows) {
        const run = rowToRun(r);
        if (run.status === "running") {
          // Left running by a restart: carry on (a step that was mid-call runs again).
          if (now.getTime() - Date.parse(run.updated_at) > 60_000) void advance(projectId, dataId, run.id).catch(() => undefined);
          continue;
        }
        const until = run.waiting?.until ? Date.parse(run.waiting.until) : null;
        if (until && until <= now.getTime()) {
          if (run.waiting?.type === "sleep") resume(projectId, dataId, run, { slept: true });
          else if (run.waiting?.type === "event") {
            const wf = await workflow(projectId, run.workflow).catch(() => null);
            if (wf) await stepStatus(dataId, run.id, wf.steps[run.step].id, "failed", null, "Timed out waiting for the event.");
            await save(dataId, { ...run, status: "failed", waiting: null, error: `Timed out waiting for "${run.waiting.event}".` });
          }
        }
      }
    }
  }
}
