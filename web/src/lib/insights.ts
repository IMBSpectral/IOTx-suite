import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { listFiles } from "./repo";
import { consultAs } from "./kb";
import { meteredFetch } from "./ai-meter";

/**
 * Workspace insights (admins): what the workspace's apps are and how much
 * they're used, and what each builder is doing, over the last 30 days. Each
 * app gets an AI-written description of who it is for and a category, made
 * once with a small model and kept.
 */

export const CATEGORIES = ["Internal tool", "Customer-facing app", "Website", "Dashboard", "Prototype", "Game", "Other"] as const;
export type AppProfile = { whoFor: string; summary: string; category: (typeof CATEGORIES)[number] };

const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Insights") });
const profileFile = (projectId: string) => path.join(PROJECTS_ROOT, "_forge", "insights", `${projectId.replace(/[^\w-]/g, "")}.json`);
const DAY = 86_400_000;
// Each page view describes at most this many new apps, so a big workspace fills in over a few visits.
const DESCRIBE_PER_LOAD = 8;

async function cachedProfile(projectId: string): Promise<AppProfile | null> {
  const raw = await fs.readFile(profileFile(projectId), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as AppProfile) : null;
}

async function describe(p: { id: string; name: string; description: string | null }, admin: { userId: string; workspaceId: string } | null): Promise<AppProfile | null> {
  const files = (await listFiles(p.id)).filter((f) => /^src\/(pages|components)\//.test(f)).slice(0, 40);
  const asks = await db.message.findMany({ where: { projectId: p.id, role: "USER" }, orderBy: { createdAt: "asc" }, take: 3, select: { content: true } });
  // Knowledge first: who the company's apps are for (teams, customers) is in its articles. Insights are for admins, searched as the admin.
  const company = admin ? await consultAs(admin.userId, admin.workspaceId, asks.map((a) => a.content.slice(0, 120)).join(" "), { context: `${p.name} ${p.description ?? ""}`, cite: false }) : null;
  const prompt =
    `An app called "${p.name}"${p.description ? ` (${p.description})` : ""}.\nIts files: ${files.join(", ") || "(none yet)"}.\n` +
    `What its builder asked for first:\n${asks.map((a) => `- ${a.content.slice(0, 300)}`).join("\n") || "(nothing)"}\n\n` +
    `Answer with JSON only: {"whoFor": "<who uses it, under 12 words>", "summary": "<what it does, one sentence>", ` +
    `"category": one of ${JSON.stringify(CATEGORIES)}}` +
    (company?.context ? `\n\n${company.context}` : "");
  try {
    const res = await client.messages.create({ model: "claude-haiku-5-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<AppProfile>;
    const profile: AppProfile = {
      whoFor: String(j.whoFor ?? "").slice(0, 120),
      summary: String(j.summary ?? "").slice(0, 240),
      category: (CATEGORIES as readonly string[]).includes(String(j.category)) ? (j.category as AppProfile["category"]) : "Other",
    };
    await fs.mkdir(path.dirname(profileFile(p.id)), { recursive: true });
    await fs.writeFile(profileFile(p.id), JSON.stringify(profile));
    return profile;
  } catch {
    return null;
  }
}

export async function workspaceInsights(workspaceId: string, adminId?: string) {
  const since = new Date(Date.now() - 30 * DAY);
  const sinceDay = since.toISOString().slice(0, 10);
  const projects = await db.project.findMany({
    where: { workspaceId, deletedAt: null, kind: { not: "library" } },
    select: { id: true, name: true, description: true, createdById: true, publishedSha: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  const ids = projects.map((p) => p.id);
  const [visits, builds, credits, members, msgs, created] = await Promise.all([
    db.siteVisit.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, day: { gte: sinceDay } }, _sum: { count: true } }),
    db.build.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, createdAt: { gte: since } }, _count: { _all: true } }),
    db.creditEntry.groupBy({ by: ["projectId", "userId"], where: { workspaceId, delta: { lt: 0 }, reason: { not: "EXPIRED" }, createdAt: { gte: since } }, _sum: { delta: true } }),
    db.membership.findMany({ where: { workspaceId }, include: { user: { select: { id: true, name: true, email: true } } } }),
    db.message.groupBy({ by: ["userId"], where: { projectId: { in: ids }, role: "USER", createdAt: { gte: since } }, _count: { _all: true }, _max: { createdAt: true } }),
    db.project.groupBy({ by: ["createdById"], where: { workspaceId, deletedAt: null, createdAt: { gte: since } }, _count: { _all: true } }),
  ]);

  let budget = DESCRIBE_PER_LOAD;
  const apps = [];
  for (const p of projects) {
    let profile = await cachedProfile(p.id);
    if (!profile && budget > 0) {
      budget--;
      profile = await describe(p, adminId ? { userId: adminId, workspaceId } : null);
    }
    const spent = credits.filter((c) => c.projectId === p.id).reduce((n, c) => n - (c._sum.delta ?? 0), 0);
    apps.push({
      id: p.id,
      name: p.name,
      published: !!p.publishedSha,
      visits30d: visits.find((v) => v.projectId === p.id)?._sum.count ?? 0,
      builds30d: builds.find((b) => b.projectId === p.id)?._count._all ?? 0,
      credits30d: spent,
      updatedAt: p.updatedAt.toISOString(),
      whoFor: profile?.whoFor ?? null,
      summary: profile?.summary ?? null,
      category: profile?.category ?? null,
    });
  }

  const builders = members.map((m) => {
    const sent = msgs.find((x) => x.userId === m.user.id);
    return {
      id: m.user.id,
      name: m.user.name ?? m.user.email,
      email: m.user.email,
      role: m.role,
      messages30d: sent?._count._all ?? 0,
      lastActive: sent?._max.createdAt?.toISOString() ?? null,
      projectsCreated30d: created.find((c) => c.createdById === m.user.id)?._count._all ?? 0,
      credits30d: credits.filter((c) => c.userId === m.user.id).reduce((n, c) => n - (c._sum.delta ?? 0), 0),
    };
  });
  return { apps, builders, categories: CATEGORIES, pending: apps.filter((a) => !a.category).length };
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything, and keep spreadsheet formulas from running.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
