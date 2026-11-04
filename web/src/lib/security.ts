import { db } from "./db";
import { scanProject, CHECKS } from "./scan";
import { sandboxExec, ensureSandbox } from "./sandbox";
import { headSha } from "./repo";
import { projectRules } from "./workspace-security";
import { backendFindings } from "./backend-scan";
import type { PentestReport } from "./pentest";
import type { DeepScan } from "./deep-scan";

/**
 * The security center: plain-language checks, findings you can fix or ignore
 * with a reason, a dependency audit, and notes the agent reads before it
 * writes code. Scans and fixes cost no credits.
 */

export type SecurityConfig = {
  disabled?: string[];
  memory?: string;
  audit?: Audit;
  lastScanAt?: string;
  /** The last pentest of the published app (see pentest.ts). */
  pentest?: PentestReport;
  /** The last AI deep scan (see deep-scan.ts); its findings are the "deep:" rules. */
  deepScan?: DeepScan;
};

export type Advisory = { id: string; title: string; url?: string; severity: string };
export type VulnerablePackage = {
  name: string;
  severity: string;
  range: string;
  fixAvailable: boolean;
  advisories: Advisory[];
};
export type Audit = { at: string; packages: VulnerablePackage[]; error?: string };

export async function getConfig(projectId: string): Promise<SecurityConfig> {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { securityConfig: true } });
  return (p.securityConfig as SecurityConfig | null) ?? {};
}

export async function setConfig(projectId: string, patch: Partial<SecurityConfig>) {
  const next = { ...(await getConfig(projectId)), ...patch };
  await db.project.update({ where: { id: projectId }, data: { securityConfig: next } });
  return next;
}

type AuditJson = {
  vulnerabilities?: Record<
    string,
    {
      name: string;
      severity: string;
      range?: string;
      fixAvailable?: unknown;
      via: (string | { source?: number; title?: string; url?: string; severity?: string })[];
    }
  >;
};

/** npm audit of production dependencies, with advisory ids (GHSA/CVE). */
export async function auditDependencies(projectId: string): Promise<Audit> {
  const state = await ensureSandbox(projectId);
  if (state.status !== "ready") return { at: new Date().toISOString(), packages: [], error: "The project container is not running." };
  const r = await sandboxExec(projectId, "npm audit --json --omit=dev 2>/dev/null || true", 180_000);
  let json: AuditJson;
  try {
    json = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    return { at: new Date().toISOString(), packages: [], error: "The audit could not run." };
  }
  const packages = Object.values(json.vulnerabilities ?? {}).map((v) => ({
    name: v.name,
    severity: v.severity,
    range: v.range ?? "",
    fixAvailable: !!v.fixAvailable,
    advisories: v.via
      .filter((x): x is { title?: string; url?: string; severity?: string } => typeof x === "object")
      .map((x) => ({
        id: x.url?.match(/GHSA-[\w-]+/)?.[0] ?? x.url?.split("/").pop() ?? "advisory",
        title: x.title ?? "Vulnerability",
        url: x.url,
        severity: x.severity ?? v.severity,
      })),
  }));
  const order = ["critical", "high", "moderate", "low", "info"];
  packages.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return { at: new Date().toISOString(), packages };
}

/** Scan the working tree with the enabled checks and record the findings. */
export async function runScan(projectId: string) {
  const config = await getConfig(projectId);
  const rules = await projectRules(projectId);
  const findings = [
    ...(await scanProject(projectId, { disabled: [...(config.disabled ?? []), ...rules.disabledChecks] })),
    ...(await backendFindings(projectId)),
  ];
  const sha = await headSha(projectId).catch(() => "unknown");

  const ignored = await db.securityFinding.findMany({ where: { projectId, ignored: true } });
  const isIgnored = (f: { rule: string; file: string }) => ignored.some((i) => i.rule === f.rule && i.file === f.file);

  // Deep-scan findings belong to the last deep scan, not to this one.
  await db.securityFinding.deleteMany({ where: { projectId, ignored: false, NOT: { rule: { startsWith: "deep:" } } } });
  const fresh = findings.filter((f) => !isIgnored(f));
  if (fresh.length) await db.securityFinding.createMany({ data: fresh.map((f) => ({ ...f, projectId, sha })) });

  const audit = await auditDependencies(projectId);
  await setConfig(projectId, { audit, lastScanAt: new Date().toISOString() });
  return { findings: fresh.length, ignored: ignored.length, audit };
}

/** The prompt for a free security fix, built from the findings themselves. */
export async function fixPrompt(projectId: string, findingIds: string[]) {
  const findings = await db.securityFinding.findMany({
    where: { projectId, id: { in: findingIds }, ignored: false },
  });
  if (findings.length === 0) return null;
  const lines = findings.map((f) => {
    const check = CHECKS.find((c) => c.id === f.rule);
    return `- ${check?.title ?? f.rule} in ${f.file}:${f.line ?? "?"} — ${check?.looksFor ?? f.detail} It passes when: ${check?.passesWhen ?? "the issue is gone."}`;
  });
  return (
    `Fix these security issues found by the security scan. Change only what each fix needs, ` +
    `keep the app working, and never put real secrets in code — read them from environment ` +
    `variables instead.\n\n${lines.join("\n")}`
  );
}

export function checksCatalog(disabled: string[] = []) {
  return CHECKS.map((c) => ({
    id: c.id,
    category: c.category,
    severity: c.severity,
    title: c.title,
    looksFor: c.looksFor,
    appliesWhen: c.appliesWhen,
    passesWhen: c.passesWhen,
    enabled: !disabled.includes(c.id),
  }));
}
