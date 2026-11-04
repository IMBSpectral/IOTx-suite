import { db } from "./db";
import { getCloud, listTables } from "./cloud";
import { listConnections } from "./connectors";
import type { Finding } from "./scan";

/**
 * Scan coverage beyond the source code: the app's database access rules
 * (public writes, personal data readable by anyone) and its tool access
 * (connectors whose credential stopped working). Reported like code findings,
 * with "cloud:<table>" or "connector:<label>" in place of a file.
 */
const PII = /(email|phone|address|password|token|secret|ssn|birth|salary|iban|card)/i;

export async function backendFindings(projectId: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const cfg = await getCloud(projectId);
  if (cfg?.enabled) {
    for (const t of await listTables(projectId).catch(() => [])) {
      if (t.policy.write === "public") {
        out.push({ rule: "cloud-public-write", severity: "HIGH", file: `cloud:${t.name}`, line: 0, detail: `Anyone can add, change or delete rows in "${t.name}" without signing in. Limit writes to signed-in users or the row's owner.` });
      }
      const sensitive = (t.columns as { name: string }[]).filter((c) => PII.test(c.name)).map((c) => c.name);
      if (t.policy.read === "public" && sensitive.length) {
        out.push({ rule: "cloud-public-pii", severity: "HIGH", file: `cloud:${t.name}`, line: 0, detail: `"${t.name}" is readable by anyone and holds ${sensitive.join(", ")}. Limit reads to signed-in users or owners.` });
      }
    }
  }
  const p = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (p) {
    for (const c of await listConnections(p.workspaceId, projectId)) {
      if (c.status === "failed") {
        out.push({ rule: "connector-failed", severity: "MEDIUM", file: `connector:${c.label}`, line: 0, detail: `The ${c.name} connection "${c.label}" failed its last check${c.error ? `: ${c.error}` : ""}. Reconnect it in Settings → Connectors.` });
      }
    }
  }
  return out;
}
