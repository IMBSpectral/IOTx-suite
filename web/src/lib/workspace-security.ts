import { randomBytes } from "node:crypto";
import { getBrand } from "./brand";
import { resolveTxt } from "node:dns/promises";
import { db } from "./db";
import { CHECKS } from "./scan";
import { getCloud } from "./cloud";

/**
 * Workspace security: an audit trail of security-relevant changes, verified
 * email domains (invites can be limited to them), workspace-wide scan rules,
 * a preview-sharing policy, and the weekly security digest.
 */

// ── Audit trail ─────────────────────────────────────────────────

export type AuditKind =
  | "ai.action"
  | "ai.memory"
  | "people.changed"
  | "permissions.changed"
  | "permissions.refused"
  | "member.invited"
  | "workspace.secret"
  | "member.removed"
  | "workspace.settings"
  | "project.shared"
  | "project.unshared"
  | "project.sharing"
  | "project.published"
  | "project.unpublished"
  | "connector.connected"
  | "connector.requested"
  | "connector.declined"
  | "connector.disconnected"
  | "domain.added"
  | "domain.verified"
  | "domain.removed"
  | "rules.changed"
  | "device.approved"
  | "session.revoked";

export async function audit(
  workspaceId: string,
  actorId: string | null,
  kind: AuditKind,
  detail: string,
  projectId?: string | null,
) {
  await db.auditEvent
    .create({ data: { workspaceId, actorId, kind, detail: detail.slice(0, 500), projectId: projectId ?? null } })
    .catch((e) => console.error("[audit]", e));
  // Event destinations get it too, in the background.
  void import("./event-destinations").then(({ emitEvent }) =>
    emitEvent(workspaceId, { kind, detail: detail.slice(0, 500), actorId, projectId: projectId ?? null }),
  );
}

export async function auditLog(workspaceId: string, take = 100) {
  const rows = await db.auditEvent.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take });
  const people = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter(Boolean) as string[])] } },
    select: { id: true, name: true, email: true },
  });
  const who = new Map(people.map((p) => [p.id, p.name ?? p.email]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    detail: r.detail,
    projectId: r.projectId,
    actor: r.actorId ? (who.get(r.actorId) ?? "Former member") : getBrand().shortName,
    at: r.createdAt.toISOString(),
  }));
}

// ── Verified domains ────────────────────────────────────────────

export type VerifiedDomain = { domain: string; token: string; verifiedAt: string | null };
export class SecurityError extends Error {}

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com"]);

export function domainsOf(ws: { verifiedDomains: unknown }): VerifiedDomain[] {
  return Array.isArray(ws.verifiedDomains) ? (ws.verifiedDomains as VerifiedDomain[]) : [];
}
export const txtRecord = (token: string) => `forge-verification=${token}`;

export async function addDomain(workspaceId: string, raw: string) {
  const domain = raw.trim().toLowerCase().replace(/^@/, "");
  if (!DOMAIN.test(domain)) throw new SecurityError("Enter a domain like example.com.");
  if (PUBLIC_MAIL.has(domain)) throw new SecurityError("Public email providers can't be verified.");
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const list = domainsOf(ws);
  if (list.some((d) => d.domain === domain)) throw new SecurityError("That domain is already added.");
  const taken = await db.workspace.findMany({ where: { id: { not: workspaceId } }, select: { verifiedDomains: true } });
  if (taken.some((w) => domainsOf(w).some((d) => d.domain === domain && d.verifiedAt))) {
    throw new SecurityError("Another workspace has verified this domain.");
  }
  const entry: VerifiedDomain = { domain, token: randomBytes(16).toString("hex"), verifiedAt: null };
  await db.workspace.update({ where: { id: workspaceId }, data: { verifiedDomains: [...list, entry] } });
  return entry;
}

/** Check the domain's DNS for the TXT record. `lookup` is replaceable for tests. */
export async function verifyDomain(workspaceId: string, domain: string, lookup: (d: string) => Promise<string[][]> = resolveTxt) {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const list = domainsOf(ws);
  const entry = list.find((d) => d.domain === domain);
  if (!entry) throw new SecurityError("Add the domain first.");
  let records: string[][] = [];
  try {
    records = await lookup(domain);
  } catch {
    records = [];
  }
  const found = records.some((parts) => parts.join("") === txtRecord(entry.token));
  if (!found) return { verified: false, entry };
  entry.verifiedAt = new Date().toISOString();
  await db.workspace.update({ where: { id: workspaceId }, data: { verifiedDomains: list } });
  return { verified: true, entry };
}

export async function removeDomain(workspaceId: string, domain: string) {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const list = domainsOf(ws).filter((d) => d.domain !== domain);
  await db.workspace.update({
    where: { id: workspaceId },
    // With no verified domain left, the invite restriction can't apply.
    data: { verifiedDomains: list, ...(list.some((d) => d.verifiedAt) ? {} : { inviteVerifiedOnly: false }) },
  });
}

/** Whether an email may be invited, given the workspace's domain rule. */
export function inviteAllowed(ws: { inviteVerifiedOnly: boolean; verifiedDomains: unknown }, email: string) {
  if (!ws.inviteVerifiedOnly) return true;
  const domain = email.split("@")[1]?.toLowerCase();
  return domainsOf(ws).some((d) => d.verifiedAt && d.domain === domain);
}

/**
 * "Sign-in only" preview links: who may open one. Workspace members, and
 * signed-in people whose email is on one of the workspace's verified domains.
 */
export async function previewViewerAllowed(ws: { id: string; verifiedDomains: unknown }, userId: string) {
  const [member, user] = await Promise.all([
    db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: ws.id } } }),
    db.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  if (member) return true;
  const domain = user?.email?.split("@")[1]?.toLowerCase();
  return !!domain && domainsOf(ws).some((d) => d.verifiedAt && d.domain === domain);
}

// ── Scan rules ──────────────────────────────────────────────────

export type BlockLevel = "critical" | "high" | "medium";
export type SecurityRules = { disabledChecks: string[]; blockPublishOn: BlockLevel };
const DEFAULT_RULES: SecurityRules = { disabledChecks: [], blockPublishOn: "high" };

export function rulesOf(ws: { securityRules: unknown } | null | undefined): SecurityRules {
  const r = (ws?.securityRules ?? {}) as Partial<SecurityRules>;
  return {
    disabledChecks: Array.isArray(r.disabledChecks) ? r.disabledChecks.filter((c) => CHECKS.some((k) => k.id === c)) : [],
    blockPublishOn: r.blockPublishOn === "critical" || r.blockPublishOn === "medium" ? r.blockPublishOn : DEFAULT_RULES.blockPublishOn,
  };
}

export async function projectRules(projectId: string) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { workspace: { select: { securityRules: true } } } });
  return rulesOf(p?.workspace);
}

const LEVELS = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
/** Whether a finding of this severity blocks publishing under the rules. */
export function blocks(severity: string, level: BlockLevel) {
  return LEVELS.indexOf(severity) <= LEVELS.indexOf(level.toUpperCase());
}

// ── Security digest ─────────────────────────────────────────────

const WEEK = 7 * 86_400_000;

export async function buildDigest(workspaceId: string, now = new Date()) {
  const since = new Date(now.getTime() - WEEK);
  const projects = await db.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: {
      id: true,
      name: true,
      publishedSha: true,
      linkAccess: true,
      securityConfig: true,
      _count: { select: { findings: { where: { resolved: false, ignored: false, severity: { in: ["CRITICAL", "HIGH"] } } } } },
    },
  });
  const [connectors, links, hooks, events] = await Promise.all([
    db.connector.findMany({ where: { workspaceId }, select: { kind: true } }),
    db.previewLink.count({ where: { project: { workspaceId }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    db.automation.count({ where: { workspaceId, webhookToken: { not: null } } }),
    db.auditEvent.findMany({ where: { workspaceId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  // MCP exposure: servers the agent can reach, and apps that serve their data over MCP.
  const appMcp: string[] = [];
  for (const p of projects) if ((await getCloud(p.id))?.mcp?.enabled) appMcp.push(p.name);
  const atRisk = projects.filter((p) => p._count.findings > 0).map((p) => ({ id: p.id, name: p.name, open: p._count.findings }));
  const neverScanned = projects.filter((p) => !(p.securityConfig as { lastScanAt?: string } | null)?.lastScanAt && p.publishedSha).map((p) => p.name);
  return {
    period: { from: since.toISOString(), to: now.toISOString() },
    findings: { projects: atRisk, total: atRisk.reduce((n, p) => n + p.open, 0) },
    neverScanned,
    exposure: {
      connectors: connectors.map((c) => c.kind),
      openPreviewLinks: links,
      webhooks: hooks,
      inviteLinks: projects.filter((p) => p.linkAccess).map((p) => p.name),
      published: projects.filter((p) => p.publishedSha).length,
      mcp: { connected: connectors.filter((c) => c.kind === "mcp").length, appServers: appMcp },
    },
    changes: events.map((e) => ({ kind: e.kind, detail: e.detail, at: e.createdAt.toISOString() })),
  };
}
export type Digest = Awaited<ReturnType<typeof buildDigest>>;

export function digestSummary(d: Digest) {
  const parts: string[] = [];
  parts.push(d.findings.total ? `${d.findings.total} open critical/high finding${d.findings.total === 1 ? "" : "s"} in ${d.findings.projects.length} project${d.findings.projects.length === 1 ? "" : "s"}` : "No open critical or high findings");
  if (d.neverScanned.length) parts.push(`${d.neverScanned.length} published project${d.neverScanned.length === 1 ? "" : "s"} never scanned`);
  parts.push(`${d.changes.length} security change${d.changes.length === 1 ? "" : "s"} this week`);
  if (d.exposure.mcp.connected || d.exposure.mcp.appServers.length) {
    parts.push(`MCP: ${d.exposure.mcp.connected} server${d.exposure.mcp.connected === 1 ? "" : "s"} connected, ${d.exposure.mcp.appServers.length} app${d.exposure.mcp.appServers.length === 1 ? "" : "s"} serving data`);
  }
  if (d.exposure.webhooks || d.exposure.openPreviewLinks) {
    parts.push(`${d.exposure.openPreviewLinks} open preview link${d.exposure.openPreviewLinks === 1 ? "" : "s"}, ${d.exposure.webhooks} webhook${d.exposure.webhooks === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/** Send the digest to owners and admins once a week (housekeeping) or on demand. */
export async function sendDigest(workspaceId: string, now = new Date()) {
  const d = await buildDigest(workspaceId, now);
  const admins = await db.membership.findMany({ where: { workspaceId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } });
  await db.notification.createMany({
    data: admins.map((a) => ({ userId: a.userId, kind: "security_digest", title: "Weekly security digest", body: digestSummary(d), href: "/settings/security" })),
  });
  await db.workspace.update({ where: { id: workspaceId }, data: { securityDigestAt: now } });
  return d;
}

export async function sendDueDigests(now = new Date()) {
  const due = await db.workspace.findMany({
    where: { securityDigest: true, OR: [{ securityDigestAt: null }, { securityDigestAt: { lt: new Date(now.getTime() - WEEK) } }] },
    select: { id: true },
  });
  for (const w of due) await sendDigest(w.id, now).catch((e) => console.error("[digest]", e));
  return due.length;
}
