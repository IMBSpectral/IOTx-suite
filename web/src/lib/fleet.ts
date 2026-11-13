import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";

/**
 * The fleet: every IOTx server (imbspectral, iforge, client servers), seen from the control
 * server (IOTX_FLEET_CONTROL=1, imbspectral.online).
 *
 * - Deployments: deploy/ship.sh uploads its log (DEPLOYMENTS.md, servers.conf, servers.info)
 *   to <PROJECTS_ROOT>/_fleet after every deploy; the Admin → Deployments page shows it.
 * - AI usage: each server answers GET /api/fleet/usage with a summary of its own Claude calls,
 *   to callers holding the shared IOTX_FLEET_KEY. The control server asks every server in
 *   servers.conf and shows them side by side. Only totals and breakdowns leave a server:
 *   no prompts, no replies, no customer data.
 */

export const isFleetControl = () => process.env.IOTX_FLEET_CONTROL === "1";
const fleetDir = () => path.join(PROJECTS_ROOT, "_fleet");

/** The caller holds this install's fleet key (constant-time compare). */
export function fleetKeyOk(req: Request) {
  const want = process.env.IOTX_FLEET_KEY ?? "";
  const got = req.headers.get("x-iotx-fleet-key") ?? "";
  if (want.length < 32 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export type FleetServer = {
  name: string;
  host: string;
  url: string;
  client: string;
  domain: string;
  droplet: string;
  region: string;
  size: string;
  off: string;
  since: string;
  notes: string;
};

/** Servers as deploy/servers.conf and servers.info describe them (uploaded by ship.sh). */
export async function fleetServers(): Promise<FleetServer[]> {
  const [conf, info] = await Promise.all([
    fs.readFile(path.join(fleetDir(), "servers.conf"), "utf8").catch(() => ""),
    fs.readFile(path.join(fleetDir(), "servers.info"), "utf8").catch(() => ""),
  ]);
  const lines = (s: string) => s.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  const meta = new Map(
    lines(info).map((l) => {
      const f = l.split("|").map((x) => x.trim());
      return [f[0], f] as const;
    }),
  );
  return lines(conf).map((l) => {
    const [name, host, url] = l.trim().split(/\s+/);
    const f = meta.get(name) ?? [];
    return { name, host, url, client: f[1] ?? "", domain: f[2] ?? "", droplet: f[3] ?? "", region: f[4] ?? "", size: f[5] ?? "", off: f[6] ?? "", since: f[7] ?? "", notes: f[8] ?? "" };
  });
}

/** The deployment log as last uploaded, and when. */
export async function deploymentLog() {
  const file = path.join(fleetDir(), "DEPLOYMENTS.md");
  const [md, st] = await Promise.all([fs.readFile(file, "utf8").catch(() => null), fs.stat(file).catch(() => null)]);
  return { markdown: md, updatedAt: st?.mtime.toISOString() ?? null, servers: await fleetServers() };
}

export type UsageSummary = {
  server: string;
  days: number;
  totals: { calls: number; failed: number; input: number; output: number; cacheWrite: number; cacheRead: number; searches: number; cost: number };
  byDay: { day: string; calls: number; cost: number }[];
  byModel: { model: string; calls: number; cost: number }[];
  byFeature: { feature: string; calls: number; cost: number }[];
  byApp: { app: string; calls: number; cost: number }[];
  byWorkspace: { name: string; calls: number; cost: number }[];
  byPerson: { name: string; calls: number; cost: number }[];
};

const usd = (micros: number | bigint | null | undefined) => Number(micros ?? 0) / 1e6;

/** This server's Claude calls over the last `days` days (0 = all time), summed. */
export async function localUsage(days: number): Promise<UsageSummary> {
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : new Date(0);
  const where = { createdAt: { gte: since } };
  const [sums, failed, byModel, byFeature, byApp, byWs, byUser, byDay] = await Promise.all([
    db.aiUsage.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, webSearches: true, costMicros: true } }),
    db.aiUsage.count({ where: { ...where, status: { gte: 400 } } }),
    db.aiUsage.groupBy({ by: ["model"], where, _count: true, _sum: { costMicros: true }, orderBy: { _sum: { costMicros: "desc" } }, take: 8 }),
    db.aiUsage.groupBy({ by: ["feature"], where, _count: true, _sum: { costMicros: true }, orderBy: { _sum: { costMicros: "desc" } }, take: 10 }),
    db.aiUsage.groupBy({ by: ["app"], where, _count: true, _sum: { costMicros: true }, orderBy: { _sum: { costMicros: "desc" } } }),
    db.aiUsage.groupBy({ by: ["workspaceId"], where, _count: true, _sum: { costMicros: true }, orderBy: { _sum: { costMicros: "desc" } }, take: 10 }),
    db.aiUsage.groupBy({ by: ["userId"], where, _count: true, _sum: { costMicros: true }, orderBy: { _sum: { costMicros: "desc" } }, take: 10 }),
    db.$queryRaw<{ day: Date; calls: bigint; cost: bigint | null }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS calls, SUM("costMicros")::bigint AS cost
      FROM ai_usage WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
  ]);
  const wsIds = byWs.map((w) => w.workspaceId).filter((x): x is string => !!x);
  const userIds = byUser.map((u) => u.userId).filter((x): x is string => !!x);
  const [spaces, people] = await Promise.all([
    db.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } }),
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
  ]);
  const space = new Map(spaces.map((s) => [s.id, s.name]));
  const person = new Map(people.map((p) => [p.id, p.name || p.email]));
  const s = sums._sum;
  return {
    server: process.env.PUBLIC_SITES_HOST ?? "",
    days,
    totals: {
      calls: sums._count,
      failed,
      input: s.inputTokens ?? 0,
      output: s.outputTokens ?? 0,
      cacheWrite: s.cacheWriteTokens ?? 0,
      cacheRead: s.cacheReadTokens ?? 0,
      searches: s.webSearches ?? 0,
      cost: usd(s.costMicros),
    },
    byDay: byDay.map((d) => ({ day: new Date(d.day).toISOString().slice(0, 10), calls: Number(d.calls), cost: usd(d.cost) })),
    byModel: byModel.map((m) => ({ model: m.model, calls: m._count, cost: usd(m._sum.costMicros) })),
    byFeature: byFeature.map((f) => ({ feature: f.feature, calls: f._count, cost: usd(f._sum.costMicros) })),
    byApp: byApp.map((a) => ({ app: a.app, calls: a._count, cost: usd(a._sum.costMicros) })),
    byWorkspace: byWs.map((w) => ({ name: w.workspaceId ? (space.get(w.workspaceId) ?? "(deleted workspace)") : "No workspace (system)", calls: w._count, cost: usd(w._sum.costMicros) })),
    byPerson: byUser.map((u) => ({ name: u.userId ? (person.get(u.userId) ?? "(deleted person)") : "System", calls: u._count, cost: usd(u._sum.costMicros) })),
  };
}

export type ServerUsage = { server: FleetServer; usage: UsageSummary | null; error: string | null };

/** Every server's AI usage, asked in parallel; a server that doesn't answer says why. */
export async function fleetUsage(days: number): Promise<ServerUsage[]> {
  const servers = await fleetServers();
  const self = (process.env.AUTH_URL ?? "").replace(/\/$/, "");
  const key = process.env.IOTX_FLEET_KEY ?? "";
  return Promise.all(
    servers.map(async (server): Promise<ServerUsage> => {
      try {
        if (server.url.replace(/\/$/, "") === self) return { server, usage: await localUsage(days), error: null };
        if (!key) return { server, usage: null, error: "This server has no fleet key (IOTX_FLEET_KEY)." };
        const r = await fetch(`${server.url.replace(/\/$/, "")}/api/fleet/usage?days=${days}`, {
          headers: { "x-iotx-fleet-key": key },
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        });
        if (r.status === 404) return { server, usage: null, error: "That server doesn't report usage yet: deploy the fleet change to it." };
        if (r.status === 401) return { server, usage: null, error: "That server didn't accept the fleet key." };
        if (!r.ok) return { server, usage: null, error: `That server answered ${r.status}.` };
        return { server, usage: (await r.json()) as UsageSummary, error: null };
      } catch (e) {
        return { server, usage: null, error: e instanceof Error && e.name === "TimeoutError" ? "That server didn't answer in time." : "Couldn't reach that server." };
      }
    }),
  );
}
