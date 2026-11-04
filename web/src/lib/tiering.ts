import { parse } from "yaml";
import { db } from "./db";
import { getCloud } from "./cloud";

/**
 * App tiering: a workspace's admins describe tiers in YAML, with rules that
 * place each app in one. The first tier with a matching rule wins; a tier
 * marked default takes everything else.
 *
 *   tiers:
 *     - name: Critical
 *       rules:
 *         - published: true
 *           labels: [customer-facing]
 *     - name: Standard
 *       rules:
 *         - published: true
 *     - name: Sandbox
 *       default: true
 *
 * Rule fields (all must hold): published, cloud (has a backend), labels (any
 * of these admin labels), nameContains, visitsAtLeast (last 30 days).
 */

export type Rule = { published?: boolean; cloud?: boolean; labels?: string[]; nameContains?: string; visitsAtLeast?: number };
export type Tier = { name: string; rules: Rule[]; default: boolean };

export class TierError extends Error {}

const RULE_KEYS = new Set(["published", "cloud", "labels", "nameContains", "visitsAtLeast"]);

export function parseTiers(text: string): Tier[] {
  if (!text.trim()) return [];
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 10 });
  } catch (e) {
    throw new TierError(`That isn't valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  const tiers = (doc as { tiers?: unknown })?.tiers;
  if (!Array.isArray(tiers) || !tiers.length) throw new TierError("Start with tiers: and list at least one tier.");
  if (tiers.length > 20) throw new TierError("Up to 20 tiers.");
  const names = new Set<string>();
  return tiers.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 40) : "";
    if (!name) throw new TierError(`Tier ${i + 1} needs a name.`);
    if (names.has(name)) throw new TierError(`There are two tiers called ${name}.`);
    names.add(name);
    const rules = Array.isArray(o.rules) ? o.rules : [];
    const clean: Rule[] = rules.map((r, j) => {
      const ro = (r ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(ro)) if (!RULE_KEYS.has(k)) throw new TierError(`${name}, rule ${j + 1}: unknown field "${k}". Use ${[...RULE_KEYS].join(", ")}.`);
      const rule: Rule = {};
      if ("published" in ro) rule.published = ro.published === true;
      if ("cloud" in ro) rule.cloud = ro.cloud === true;
      if ("labels" in ro) {
        if (!Array.isArray(ro.labels)) throw new TierError(`${name}, rule ${j + 1}: labels is a list.`);
        rule.labels = ro.labels.map((l) => String(l).toLowerCase());
      }
      if ("nameContains" in ro) rule.nameContains = String(ro.nameContains).toLowerCase();
      if ("visitsAtLeast" in ro) {
        const n = Number(ro.visitsAtLeast);
        if (!Number.isFinite(n) || n < 0) throw new TierError(`${name}, rule ${j + 1}: visitsAtLeast is a number.`);
        rule.visitsAtLeast = n;
      }
      return rule;
    });
    if (!clean.length && o.default !== true) throw new TierError(`${name} needs rules, or default: true.`);
    return { name, rules: clean, default: o.default === true };
  });
}

type AppFacts = { name: string; published: boolean; cloud: boolean; labels: string[]; visits: number };

function matches(rule: Rule, a: AppFacts) {
  if (rule.published !== undefined && rule.published !== a.published) return false;
  if (rule.cloud !== undefined && rule.cloud !== a.cloud) return false;
  if (rule.labels && !rule.labels.some((l) => a.labels.includes(l))) return false;
  if (rule.nameContains && !a.name.toLowerCase().includes(rule.nameContains)) return false;
  if (rule.visitsAtLeast !== undefined && a.visits < rule.visitsAtLeast) return false;
  return true;
}

export function tierFor(tiers: Tier[], a: AppFacts) {
  for (const t of tiers) if (t.rules.some((r) => matches(r, a))) return t.name;
  return tiers.find((t) => t.default)?.name ?? null;
}

/** Every app in the workspace with its labels and tier. */
export async function tieredApps(workspaceId: string) {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { tieringYaml: true } });
  const tiers = ws.tieringYaml ? parseTiers(ws.tieringYaml) : [];
  const projects = await db.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, name: true, publishedSha: true, adminLabels: true },
    orderBy: { name: "asc" },
  });
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const visits = await db.siteVisit.groupBy({ by: ["projectId"], where: { projectId: { in: projects.map((p) => p.id) }, day: { gte: since } }, _sum: { count: true } });
  const out = [];
  for (const p of projects) {
    const facts: AppFacts = {
      name: p.name,
      published: !!p.publishedSha,
      cloud: !!(await getCloud(p.id).catch(() => null))?.enabled,
      labels: p.adminLabels,
      visits: visits.find((v) => v.projectId === p.id)?._sum.count ?? 0,
    };
    out.push({ id: p.id, name: p.name, labels: p.adminLabels, published: facts.published, cloud: facts.cloud, visits30d: facts.visits, tier: tierFor(tiers, facts) });
  }
  return { yaml: ws.tieringYaml ?? "", tiers: tiers.map((t) => t.name), apps: out };
}

export async function saveTiering(workspaceId: string, yaml: string) {
  if (yaml.length > 20_000) throw new TierError("Keep the rules under 20,000 characters.");
  parseTiers(yaml);
  await db.workspace.update({ where: { id: workspaceId }, data: { tieringYaml: yaml.trim() ? yaml : null } });
}

export async function setLabels(workspaceId: string, projectId: string, labels: string[]) {
  const clean = [...new Set(labels.map((l) => String(l).trim().toLowerCase()).filter((l) => /^[a-z0-9][a-z0-9-]{0,29}$/.test(l)))].slice(0, 10);
  const { count } = await db.project.updateMany({ where: { id: projectId, workspaceId }, data: { adminLabels: clean } });
  if (!count) throw new TierError("Project not found.");
  return clean;
}
