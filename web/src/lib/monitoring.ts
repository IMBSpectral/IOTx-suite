import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { db } from "./db";
import { buildDir } from "./paths";
import { readLogs } from "./runtime-logs";
import { runScan } from "./security";
import { ensureMainSnapshot, seoCheck, type Seo } from "./publish";
import { notify, projectAdmins } from "./sharing";
import { siteAnalytics } from "./projects";
import { getCloud } from "./cloud";
import { cloudHealth } from "./cloud-ops";
import { SITES_HOSTNAME } from "./site-host";

/**
 * Project monitoring: health runs that look at the live site, recent runtime
 * errors, security, dependencies, SEO and bundle weight, on a schedule or on
 * demand. Each finding has a stable key, so a run can tell what is new, what
 * was ignored, and what is already being fixed.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type HealthFinding = {
  key: string;
  category: "Uptime" | "Runtime" | "Security" | "Dependencies" | "SEO" | "Performance" | "Anomaly";
  severity: Severity;
  title: string;
  detail: string;
  /** What to ask the agent for when the user clicks Fix. */
  fix: string;
};
export type HealthRun = { at: string; trigger: "schedule" | "manual" | "seo"; findings: HealthFinding[]; error?: string };
export type Monitoring = {
  on: boolean;
  frequency: "daily" | "weekly";
  runs: HealthRun[];
  ignored: string[];
  /** finding key -> build id of the fix in progress */
  fixing: Record<string, string>;
};

const DEFAULTS: Monitoring = { on: false, frequency: "daily", runs: [], ignored: [], fixing: {} };
const KEEP_RUNS = 20;
const PERIOD = { daily: 86_400_000, weekly: 7 * 86_400_000 };

export async function getMonitoring(projectId: string): Promise<Monitoring> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { monitoring: true } });
  return { ...DEFAULTS, ...((p?.monitoring as Partial<Monitoring> | null) ?? {}) };
}

export async function setMonitoring(projectId: string, patch: Partial<Monitoring>) {
  const next = { ...(await getMonitoring(projectId)), ...patch };
  await db.project.update({ where: { id: projectId }, data: { monitoring: next } });
  return next;
}

const hash = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
};

/** GET the live site's index through the hosting route, as a visitor would. */
function probe(subdomain: string): Promise<{ status: number; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const r = http.request(
      { host: "127.0.0.1", port: Number(process.env.PORT ?? 3000), path: "/", headers: { host: `${subdomain}.${SITES_HOSTNAME}` }, timeout: 15_000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: Date.now() - started }));
      },
    );
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve({ status: 0, ms: Date.now() - started }));
    r.end();
  });
}

async function uptime(project: { subdomain: string; publishedSha: string | null; publishAudience: string }): Promise<HealthFinding[]> {
  if (!project.publishedSha) return [];
  const { status, ms } = await probe(project.subdomain);
  // A private site answers with the sign-in handshake, which is healthy.
  const ok = status === 200 || (project.publishAudience !== "public" && status === 302);
  const out: HealthFinding[] = [];
  if (!ok) {
    out.push({
      key: "uptime.down",
      category: "Uptime",
      severity: "critical",
      title: "The live site isn't responding",
      detail: status ? `The home page answered with HTTP ${status}.` : "The home page didn't answer within 15 seconds.",
      fix: "The published site's home page is not loading. Find out why the production build fails to serve and fix it, then I'll republish.",
    });
  } else if (ms > 3000) {
    out.push({
      key: "uptime.slow",
      category: "Uptime",
      severity: "medium",
      title: "The live site is slow to respond",
      detail: `The home page took ${(ms / 1000).toFixed(1)}s to answer.`,
      fix: "The home page of the live site is slow to load. Reduce what the first page load does and make it faster.",
    });
  }
  return out;
}

function runtime(projectId: string): HealthFinding[] {
  const since = Date.now() - 86_400_000;
  const errors = readLogs(projectId).filter((l) => l.level === "error" && l.at >= since && l.kind !== "console");
  const seen = new Map<string, { message: string; count: number; file?: string }>();
  for (const e of errors) {
    const k = e.message.slice(0, 200);
    const cur = seen.get(k);
    seen.set(k, { message: e.message, count: (cur?.count ?? 0) + e.count, file: e.file });
  }
  return [...seen.values()].slice(0, 5).map((e) => ({
    key: `runtime.${hash(e.message)}`,
    category: "Runtime" as const,
    severity: "high" as const,
    title: "Runtime error in the app",
    detail: `${e.message.slice(0, 300)}${e.file ? ` (${e.file})` : ""} · seen ${e.count}× in the last 24 hours`,
    fix: `This error keeps happening in the app: "${e.message.slice(0, 300)}". Find the cause and fix it.`,
  }));
}

async function security(projectId: string): Promise<HealthFinding[]> {
  const scan = await runScan(projectId);
  const open = await db.securityFinding.findMany({
    where: { projectId, ignored: false, resolved: false, severity: { in: ["CRITICAL", "HIGH"] } },
  });
  const out: HealthFinding[] = open.slice(0, 5).map((f) => ({
    key: `security.${f.rule}.${hash(f.file)}`,
    category: "Security",
    severity: f.severity === "CRITICAL" ? "critical" : "high",
    title: f.detail.split(".")[0].slice(0, 120) || f.rule,
    detail: `${f.file}${f.line ? `:${f.line}` : ""} · ${f.detail.slice(0, 300)}`,
    fix: `Fix this security issue in ${f.file}${f.line ? ` line ${f.line}` : ""}: ${f.detail}`,
  }));
  for (const pkg of scan.audit.packages.filter((p) => p.severity === "critical" || p.severity === "high").slice(0, 5)) {
    out.push({
      key: `deps.${pkg.name}`,
      category: "Dependencies",
      severity: pkg.severity === "critical" ? "critical" : "high",
      title: `Vulnerable dependency: ${pkg.name}`,
      detail: `${pkg.advisories.map((a) => a.title).join("; ").slice(0, 300)}${pkg.fixAvailable ? " · an update fixes it" : ""}`,
      fix: `Update the dependency ${pkg.name} to a version without the known vulnerabilities, and fix anything the update breaks.`,
    });
  }
  return out;
}

async function seoAndWeight(projectId: string): Promise<HealthFinding[]> {
  const snap = await ensureMainSnapshot(projectId);
  if (!snap.ok) {
    return [
      {
        key: "build.failed",
        category: "Performance",
        severity: "critical",
        title: "The app doesn't build",
        detail: (snap.error ?? "The production build failed.").slice(0, 400),
        fix: `The production build fails with this error. Fix it:\n\n${(snap.error ?? "").slice(0, 2000)}`,
      },
    ];
  }
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { seo: true } });
  const seo = await seoCheck(projectId, snap.sha, (project.seo as Seo | null) ?? {});
  const out: HealthFinding[] = seo.items
    .filter((i) => i.severity !== "info")
    .map((i) => ({
      key: `seo.${hash(i.title)}`,
      category: "SEO" as const,
      severity: (i.severity === "critical" || i.severity === "high" ? "medium" : "low") as Severity,
      title: i.title,
      detail: i.detail ?? "",
      fix: `SEO: ${i.title}. ${i.detail ?? ""} Fix this so the site shows up well in search and social previews.`,
    }));

  // Bundle weight: the JavaScript a first visit downloads.
  const assets = path.join(buildDir(projectId, snap.sha), "assets");
  const files = await fs.readdir(assets).catch(() => [] as string[]);
  let js = 0;
  for (const f of files.filter((f) => f.endsWith(".js"))) js += (await fs.stat(path.join(assets, f))).size;
  if (js > 600 * 1024) {
    out.push({
      key: "perf.bundle",
      category: "Performance",
      severity: js > 1500 * 1024 ? "high" : "medium",
      title: "Large JavaScript bundle",
      detail: `The app ships ${(js / 1024).toFixed(0)} KB of JavaScript.`,
      fix: "The app's JavaScript bundle is large. Split routes with lazy loading and remove unused heavy dependencies so the first load is faster.",
    });
  }
  return out;
}

/** Run every check (or only the SEO review) and record the run. */
/**
 * Statistical anomalies in daily traffic: yesterday (the last complete day)
 * against the 14 days before it. A drop or spike counts only when it is far
 * outside the usual spread (3 standard deviations) and large in absolute terms.
 */
export function trafficAnomalies(series: { day: string; visits: number }[]): HealthFinding[] {
  if (series.length < 16) return [];
  const observed = series[series.length - 2];
  const base = series.slice(-16, -2).map((d) => d.visits);
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length);
  if (mean < 10) return [];
  const out: HealthFinding[] = [];
  if (observed.visits < mean - 3 * sd && observed.visits < mean * 0.4) {
    out.push({
      key: "anomaly.traffic-drop",
      category: "Anomaly",
      severity: "high",
      title: "Traffic dropped sharply",
      detail: `${observed.visits} visits on ${observed.day}, against about ${Math.round(mean)} a day over the previous two weeks. Check the site loads and nothing broke in the last publish.`,
      fix: "Traffic to the published app dropped sharply yesterday. Check for anything that could stop pages loading (errors on load, broken routes, a bad last publish) and fix it.",
    });
  }
  if (observed.visits > mean + 3 * sd && observed.visits > mean * 3) {
    out.push({
      key: "anomaly.traffic-spike",
      category: "Anomaly",
      severity: "medium",
      title: "Unusual traffic spike",
      detail: `${observed.visits} visits on ${observed.day}, against about ${Math.round(mean)} a day. Good news if you launched something; otherwise it may be bots.`,
      fix: "The app had an unusual traffic spike. Review whether any endpoints or forms could be abused by bots, and add rate limits or bot protection where needed.",
    });
  }
  return out;
}

async function anomalies(projectId: string): Promise<HealthFinding[]> {
  const out = trafficAnomalies((await siteAnalytics(projectId, 16)).series);
  const cfg = await getCloud(projectId);
  if (cfg?.enabled) {
    const h = await cloudHealth(projectId).catch(() => null);
    if (h && h.requestsLastHour >= 20 && h.errorsLastHour / h.requestsLastHour > 0.2) {
      out.push({
        key: "anomaly.backend-errors",
        category: "Anomaly",
        severity: "high",
        title: "Backend error rate spiked",
        detail: `${h.errorsLastHour} of ${h.requestsLastHour} backend requests failed in the last hour.`,
        fix: "Many requests to the app's backend are failing. Check the Cloud logs and the app's data calls, and fix the cause.",
      });
    }
  }
  return out;
}

export async function runHealth(projectId: string, trigger: HealthRun["trigger"]): Promise<HealthRun> {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const before = await getMonitoring(projectId);
  let findings: HealthFinding[] = [];
  let error: string | undefined;
  try {
    if (trigger === "seo") {
      findings = (await seoAndWeight(projectId)).filter((f) => f.category === "SEO" || f.key === "build.failed");
    } else {
      const parts = await Promise.allSettled([uptime(project), Promise.resolve(runtime(projectId)), security(projectId), seoAndWeight(projectId), anomalies(projectId)]);
      for (const p of parts) {
        if (p.status === "fulfilled") findings.push(...p.value);
        else error = String(p.reason instanceof Error ? p.reason.message : p.reason).slice(0, 300);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const order: Severity[] = ["critical", "high", "medium", "low"];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const run: HealthRun = { at: new Date().toISOString(), trigger, findings, error };

  // Fixes that finished no longer count as "being fixed".
  const fixing: Record<string, string> = {};
  for (const [key, buildId] of Object.entries(before.fixing)) {
    const b = await db.build.findUnique({ where: { id: buildId }, select: { status: true } });
    if (b && (b.status === "QUEUED" || b.status === "RUNNING")) fixing[key] = buildId;
  }
  await setMonitoring(projectId, { runs: [run, ...before.runs].slice(0, KEEP_RUNS), fixing });

  // Tell the project's admins about issues they haven't seen before.
  const known = new Set([...(before.runs[0]?.findings.map((f) => f.key) ?? []), ...before.ignored]);
  const fresh = findings.filter((f) => !known.has(f.key) && (f.severity === "critical" || f.severity === "high"));
  if (fresh.length && trigger === "schedule") {
    await notify(await projectAdmins(project), {
      projectId,
      kind: "monitoring",
      title: `${fresh.length} new ${fresh.length === 1 ? "issue" : "issues"} in ${project.name}`,
      body: fresh.map((f) => f.title).join(" · ").slice(0, 200),
      href: `/projects/${projectId}?health=1`,
    });
  }
  return run;
}

/** Monitored projects whose next run is due. */
export async function dueProjects(now = Date.now()) {
  const rows = await db.project.findMany({
    // No JSON-column filter here: the local PGlite server dropped connections
    // on it. Monitoring settings are read and filtered below instead.
    where: { deletedAt: null },
    select: { id: true, monitoring: true },
  });
  return rows
    .filter((r) => {
      const m = { ...DEFAULTS, ...((r.monitoring as Partial<Monitoring> | null) ?? {}) };
      if (!m.on) return false;
      const last = m.runs.find((x) => x.trigger === "schedule")?.at;
      return !last || now - new Date(last).getTime() >= PERIOD[m.frequency];
    })
    .map((r) => r.id);
}

const state = globalThis as { __forgeMonitor?: ReturnType<typeof setInterval> };

/** Background scheduler: checks for due projects every ten minutes, one at a time. */
export function ensureMonitor() {
  if (state.__forgeMonitor) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const id of await dueProjects()) await runHealth(id, "schedule").catch(() => undefined);
    } finally {
      busy = false;
    }
  };
  state.__forgeMonitor = setInterval(tick, 10 * 60_000);
  setTimeout(tick, 30_000);
}
