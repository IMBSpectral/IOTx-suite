import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { getCloud } from "./cloud";
import { jobsOf } from "./cloud-jobs";
import { membersExtra } from "./members-extra";
import { ssoSettings } from "./sso";
import { pendingConnectorRequests } from "./connector-requests";

/**
 * The admin action center: everything in a workspace that waits on an
 * admin, in one place. Approval requests (access, publishing), anomalies to
 * acknowledge (backends paused for heavy traffic or credits, failing
 * scheduled jobs), connector requests, and a per-project security dashboard.
 */

const ackFile = (workspaceId: string) => path.join(PROJECTS_ROOT, "_forge", "action-acks", `${workspaceId.replace(/[^\w-]/g, "")}.json`);
async function acks(workspaceId: string): Promise<Record<string, string>> {
  const raw = await fs.readFile(ackFile(workspaceId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

export async function acknowledge(workspaceId: string, id: string, userId: string) {
  const a = await acks(workspaceId);
  a[id] = `${new Date().toISOString()} ${userId}`;
  // Old acknowledgements are dropped once there are many.
  const entries = Object.entries(a).slice(-500);
  await fs.mkdir(path.dirname(ackFile(workspaceId)), { recursive: true });
  await fs.writeFile(ackFile(workspaceId), JSON.stringify(Object.fromEntries(entries)));
}

export async function actionCenter(workspaceId: string) {
  const projects = await db.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, name: true, publishRequestedAt: true, publishRequestedById: true },
  });
  const ids = projects.map((p) => p.id);
  const name = new Map(projects.map((p) => [p.id, p.name]));
  const [access, findings] = await Promise.all([
    db.accessRequest.findMany({ where: { projectId: { in: ids }, status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.securityFinding.groupBy({ by: ["projectId", "severity"], where: { projectId: { in: ids }, resolved: false, ignored: false }, _count: { _all: true } }),
  ]);
  const people = await db.user.findMany({
    where: { id: { in: [...new Set([...access.map((a) => a.userId), ...projects.map((p) => p.publishRequestedById).filter(Boolean) as string[]])] } },
    select: { id: true, email: true, name: true },
  });
  const who = (id: string | null) => people.find((p) => p.id === id)?.email ?? "someone";

  const acked = await acks(workspaceId);
  const anomalies: { id: string; projectId: string; project: string; title: string; detail: string; at: string }[] = [];
  for (const p of projects) {
    const cfg = await getCloud(p.id).catch(() => null);
    if (!cfg?.enabled) continue;
    if (cfg.paused && (cfg.paused.reason === "excessive_usage" || cfg.paused.reason === "out_of_credits" || cfg.paused.reason === "credit_limit")) {
      anomalies.push({
        id: `paused:${p.id}:${cfg.paused.at}`,
        projectId: p.id,
        project: p.name,
        title: cfg.paused.reason === "excessive_usage" ? "Backend paused for unusually heavy traffic" : "Backend paused for credits",
        detail: "The app's backend is answering with errors until it's woken in the Cloud tab.",
        at: cfg.paused.at,
      });
    }
    for (const j of jobsOf(cfg)) {
      if (j.enabled && j.lastStatus && j.lastStatus >= 400 && j.lastRunAt) {
        anomalies.push({ id: `job:${p.id}:${j.id}:${j.lastRunAt}`, projectId: p.id, project: p.name, title: `Scheduled job "${j.name}" failed`, detail: `Last run answered ${j.lastStatus}.`, at: j.lastRunAt });
      }
    }
  }

  // SSO provider health: a failing check is an anomaly until someone looks.
  const sso = (await ssoSettings(workspaceId).catch(() => null))?.config;
  if (sso?.enabled && sso.check && !sso.check.ok) {
    anomalies.push({ id: `sso:${sso.check.at}`, projectId: "", project: "", title: "SSO provider check failing", detail: sso.check.error ?? "", at: sso.check.at });
  }

  const security = ids
    .map((id) => {
      const rows = findings.filter((f) => f.projectId === id);
      const count = (s: string) => rows.find((r) => r.severity === s)?._count._all ?? 0;
      return { projectId: id, project: name.get(id)!, critical: count("CRITICAL"), high: count("HIGH"), medium: count("MEDIUM"), low: count("LOW") };
    })
    .filter((s) => s.critical + s.high + s.medium + s.low > 0)
    .sort((a, b) => b.critical - a.critical || b.high - a.high);

  const roleAsks = (await membersExtra(workspaceId)).roleRequests;
  const connectorAsks = await pendingConnectorRequests(workspaceId);
  const askers = await db.user.findMany({ where: { id: { in: [...roleAsks.map((r) => r.userId), ...connectorAsks.map((r) => r.userId)] } }, select: { id: true, email: true } });
  return {
    approvals: [
      ...connectorAsks.map((r) => ({
        id: r.id,
        type: "connector" as const,
        projectId: r.projectId ?? "",
        project: r.projectId ? (name.get(r.projectId) ?? "") : "",
        by: askers.find((a) => a.id === r.userId)?.email ?? "someone",
        detail: `asks to connect ${r.name}${r.label ? ` (${r.label})` : ""}${r.scope === "project" ? " for one project" : " for the workspace"}${r.reason ? `: “${r.reason}”` : ""}`,
        at: r.at,
      })),
      ...roleAsks.map((r) => ({
        id: r.id,
        type: "role" as const,
        projectId: "",
        project: "",
        by: askers.find((a) => a.id === r.userId)?.email ?? "someone",
        detail: `asks to be ${r.to.toLowerCase()} (now ${r.from.toLowerCase()})${r.reason ? `: “${r.reason}”` : ""}`,
        at: r.at,
      })),
      ...access.map((a) => ({ id: a.id, type: "access" as const, projectId: a.projectId, project: name.get(a.projectId)!, by: who(a.userId), detail: `asks to ${a.kind === "edit" ? "edit" : "view"}${a.message ? `: “${a.message.slice(0, 200)}”` : ""}`, at: a.createdAt.toISOString() })),
      ...projects
        .filter((p) => p.publishRequestedAt)
        .map((p) => ({ id: `publish:${p.id}`, type: "publish" as const, projectId: p.id, project: p.name, by: who(p.publishRequestedById), detail: "asks to publish", at: p.publishRequestedAt!.toISOString() })),
    ].sort((a, b) => b.at.localeCompare(a.at)),
    anomalies: anomalies.filter((a) => !acked[a.id]).sort((a, b) => b.at.localeCompare(a.at)),
    security,
  };
}
