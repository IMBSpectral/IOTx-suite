import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import { CloudError, cloudUrl, getCloud, openDatabase, updateCloud, type CloudConfig } from "./cloud";
import { invokeFunction, knownFunctionNames, sweepFunctionContainers } from "./cloud-functions";
import { describeSchedule, nextRun, parseCron, validTimeZone } from "./cron";
import { PROJECTS_ROOT } from "./paths";

/**
 * Scheduled jobs ("Project jobs"): call one of the app's server functions on
 * a cron schedule, with a run history, an on/off switch and the run time each
 * job has used (billed with the rest of function run time).
 */

export type Job = {
  id: string;
  name: string;
  fn: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  /** JSON sent as the request body. */
  body?: string;
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt?: string | null;
  lastStatus?: number | null;
};

export type JobRun = { at: string; job_id: string; status: number; ms: number; error: string | null };

const MAX_JOBS = 20;

export const jobsOf = (cfg: CloudConfig) => (cfg as CloudConfig & { jobs?: Job[] }).jobs ?? [];

async function runsTable(projectId: string) {
  const db = openDatabase(projectId);
  await db.ensure(`CREATE TABLE IF NOT EXISTS _forge_job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, job_id TEXT NOT NULL,
    status INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT)`);
  return db;
}

function checkSchedule(schedule: string, timezone: string) {
  if (!validTimeZone(timezone)) throw new CloudError("Unknown time zone.");
  try {
    parseCron(schedule);
  } catch (e) {
    throw new CloudError(e instanceof Error ? e.message : String(e));
  }
  const next = nextRun(schedule, timezone);
  if (!next) throw new CloudError("That schedule never runs.");
  return next;
}

function checkBody(body: string | undefined) {
  if (!body) return undefined;
  try {
    JSON.parse(body);
  } catch {
    throw new CloudError("The request body must be JSON.");
  }
  if (body.length > 10_000) throw new CloudError("The request body is too long.");
  return body;
}

export async function createJob(
  projectId: string,
  input: { name: string; fn: string; schedule: string; timezone?: string; body?: string },
) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new CloudError("Give the job a name.");
  if (!(await knownFunctionNames(projectId, cfg)).includes(input.fn)) throw new CloudError(`There is no function called ${input.fn}.`);
  const timezone = input.timezone || "UTC";
  const schedule = input.schedule.trim();
  const next = checkSchedule(schedule, timezone);
  const job: Job = {
    id: crypto.randomUUID(),
    name,
    fn: input.fn,
    schedule,
    timezone,
    enabled: true,
    body: checkBody(input.body),
    createdAt: new Date().toISOString(),
    nextRunAt: next.toISOString(),
  };
  await updateCloud(projectId, (c) => {
    const jobs = ((c as CloudConfig & { jobs?: Job[] }).jobs ??= []);
    if (jobs.length >= MAX_JOBS) throw new CloudError(`At most ${MAX_JOBS} jobs.`);
    jobs.push(job);
  });
  return job;
}

export async function updateJob(
  projectId: string,
  id: string,
  patch: { enabled?: boolean; schedule?: string; timezone?: string; name?: string; body?: string },
) {
  let out: Job | undefined;
  await updateCloud(projectId, (c) => {
    const job = jobsOf(c).find((j) => j.id === id);
    if (!job) throw new CloudError("Job not found", 404);
    if (patch.name !== undefined) job.name = patch.name.trim().slice(0, 80) || job.name;
    if (patch.body !== undefined) job.body = checkBody(patch.body);
    if (patch.schedule !== undefined || patch.timezone !== undefined) {
      job.schedule = (patch.schedule ?? job.schedule).trim();
      job.timezone = patch.timezone ?? job.timezone;
      job.nextRunAt = checkSchedule(job.schedule, job.timezone).toISOString();
    }
    if (patch.enabled !== undefined) {
      job.enabled = patch.enabled;
      // Turning a job back on starts from now, not from the runs it missed.
      if (patch.enabled) job.nextRunAt = nextRun(job.schedule, job.timezone)?.toISOString() ?? null;
    }
    out = { ...job };
  });
  return out!;
}

export async function deleteJob(projectId: string, id: string) {
  await updateCloud(projectId, (c) => {
    const jobs = jobsOf(c);
    if (!jobs.some((j) => j.id === id)) throw new CloudError("Job not found", 404);
    (c as CloudConfig & { jobs?: Job[] }).jobs = jobs.filter((j) => j.id !== id);
  });
  await (await runsTable(projectId)).run("DELETE FROM _forge_job_runs WHERE job_id = ?", [id]);
}

/** Run a job now (on schedule or by hand). */
export async function runJob(projectId: string, id: string, manual = false) {
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't enabled for this project.`, 404);
  const job = jobsOf(cfg).find((j) => j.id === id);
  if (!job) throw new CloudError("Job not found", 404);
  const started = Date.now();
  let status = 500;
  let error: string | null = null;
  let body = "";
  try {
    const res = await invokeFunction(
      projectId,
      cfg,
      job.fn,
      {
        method: "POST",
        url: `${cloudUrl(projectId)}/functions/${job.fn}`,
        headers: { "content-type": "application/json", "x-forge-job": job.id },
        body: Buffer.from(job.body ?? "{}"),
      },
      null,
      "job",
    );
    status = res.status;
    body = res.body.toString("utf8");
    if (status >= 400) error = body.slice(0, 500);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    status = e instanceof CloudError ? e.status : 500;
  }
  const ms = Date.now() - started;
  const at = new Date().toISOString();
  const runs = await runsTable(projectId);
  await runs.run("INSERT INTO _forge_job_runs (at, job_id, status, ms, error) VALUES (?, ?, ?, ?, ?)", [at, id, status, ms, error]);
  await runs.run("DELETE FROM _forge_job_runs WHERE id <= (SELECT MAX(id) - 2000 FROM _forge_job_runs)");
  await updateCloud(projectId, (c) => {
    const j = jobsOf(c).find((x) => x.id === id);
    if (!j) return;
    j.lastRunAt = at;
    j.lastStatus = status;
    if (!manual) j.nextRunAt = nextRun(j.schedule, j.timezone)?.toISOString() ?? null;
  }).catch(() => undefined);
  return { at, status, ms, error, body: body.slice(0, 2000) };
}

/** Jobs with their description, run counts and run time over 30 days, for the Cloud tab. */
export async function jobSummary(projectId: string, cfg: CloudConfig) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stats = await (await runsTable(projectId)).all<{ job_id: string; runs: number; failed: number; ms: number }>(
    "SELECT job_id, COUNT(*) AS runs, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed, SUM(ms) AS ms FROM _forge_job_runs WHERE at >= ? GROUP BY job_id",
    [since],
  );
  return jobsOf(cfg).map((j) => {
    const s = stats.find((x) => x.job_id === j.id);
    return {
      ...j,
      description: describeSchedule(j.schedule, j.timezone),
      runs30d: Number(s?.runs ?? 0),
      failed30d: Number(s?.failed ?? 0),
      seconds30d: Math.round(Number(s?.ms ?? 0) / 1000),
    };
  });
}

export async function jobRuns(projectId: string, id: string, limit = 50) {
  return (await runsTable(projectId)).all<JobRun>("SELECT at, job_id, status, ms, error FROM _forge_job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?", [
    id,
    Math.min(500, limit),
  ]);
}

// ── Scheduler ─────────────────────────────────────────────────────────────

const inFlight = new Set<string>();

/** One pass over every Cloud backend: start the jobs that are due. */
export async function tickJobs(now = new Date()) {
  const root = path.join(PROJECTS_ROOT, "_cloud");
  const ids = (await fs.readdir(root).catch(() => [] as string[])).filter((d) => !d.startsWith("_"));
  let started = 0;
  for (const projectId of ids) {
    const cfg = await getCloud(projectId).catch(() => null);
    if (!cfg?.enabled || cfg.paused) continue;
    for (const j of jobsOf(cfg)) {
      if (!j.enabled || !j.nextRunAt || new Date(j.nextRunAt) > now) continue;
      const key = `${projectId}:${j.id}`;
      // A job still running from last time is skipped, not piled up.
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      started++;
      void runJob(projectId, j.id)
        .catch(() => undefined)
        .finally(() => inFlight.delete(key));
    }
  }
  return started;
}

const state = globalThis as { __forgeJobs?: ReturnType<typeof setInterval> };

/** Background scheduler, checked every 30 seconds. */
export function ensureJobs() {
  if (state.__forgeJobs) return;
  void sweepFunctionContainers().catch(() => undefined);
  let busy = false;
  state.__forgeJobs = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tickJobs();
      await (await import("./cloud-workflows")).tickWorkflows();
    } catch {
      // Retried on the next pass.
    } finally {
      busy = false;
    }
  }, Number(process.env.FORGE_JOBS_TICK_MS ?? 30_000));
}
