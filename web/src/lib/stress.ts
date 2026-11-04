import http from "node:http";
import https from "node:https";
import { db } from "./db";
import { siteUrl } from "./publish";

/**
 * Stress testing a published app: many requests at once for a few seconds,
 * then latency percentiles, throughput and errors. Only the project's own
 * published site can be targeted, and the load is capped, so this can't be
 * pointed at anyone else.
 */
export const MAX_CONCURRENCY = 50;
export const MAX_SECONDS = 30;

export class StressError extends Error {}

export type StressResult = {
  url: string;
  concurrency: number;
  seconds: number;
  requests: number;
  errors: number;
  statuses: Record<string, number>;
  rps: number;
  latencyMs: { p50: number; p90: number; p99: number; max: number };
  at: string;
};

/** One GET; *.localhost sites are reached on 127.0.0.1 with the right Host header. */
function hit(target: URL): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  const local = target.hostname.endsWith(".localhost");
  const mod = target.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(
      {
        host: local ? "127.0.0.1" : target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "GET",
        headers: { host: target.host, "user-agent": "Forge stress test" },
        timeout: 15_000,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - started }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, ms: performance.now() - started }));
    req.end();
  });
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export async function stressTest(projectId: string, opts: { path?: string; concurrency?: number; seconds?: number }): Promise<StressResult> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { subdomain: true, publishedSha: true } });
  if (!p?.publishedSha) throw new StressError("Publish the app first: stress tests run against the published site.");
  const pathPart = (opts.path ?? "/").startsWith("/") ? (opts.path ?? "/") : `/${opts.path}`;
  const target = new URL(pathPart, siteUrl(p.subdomain));
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(opts.concurrency ?? 10)));
  const seconds = Math.min(MAX_SECONDS, Math.max(1, Math.floor(opts.seconds ?? 10)));
  const until = Date.now() + seconds * 1000;
  const times: number[] = [];
  const statuses: Record<string, number> = {};
  let errors = 0;
  const worker = async () => {
    while (Date.now() < until) {
      const r = await hit(target);
      times.push(r.ms);
      statuses[r.status || "failed"] = (statuses[r.status || "failed"] ?? 0) + 1;
      if (r.status === 0 || r.status >= 500) errors++;
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - started) / 1000;
  const sorted = [...times].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n);
  return {
    url: target.toString(),
    concurrency,
    seconds,
    requests: times.length,
    errors,
    statuses,
    rps: Math.round((times.length / elapsed) * 10) / 10,
    latencyMs: { p50: round(pct(sorted, 50)), p90: round(pct(sorted, 90)), p99: round(pct(sorted, 99)), max: round(sorted.at(-1) ?? 0) },
    at: new Date().toISOString(),
  };
}
