import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { isPlatformAdmin } from "@/lib/platform-admin";

/**
 * Admin → AI usage: every Claude call (lib/ai-meter), with the tokens Claude
 * reported and the cost at Anthropic's list prices.
 *   GET ?q=&page=&size=&days=&app=&scope=all
 *     -> { rows, total, page, size, totals, byFeature, byModel, canAll }
 * Workspace owners and admins see their workspace; platform admins can see all.
 * ?format=csv returns the matching rows (up to 20,000) as a CSV file.
 */
const usd = (micros: number) => micros / 1e6;

async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } }, select: { role: true } });
  const platform = isPlatformAdmin(user.email);
  if (!platform && m?.role !== "OWNER" && m?.role !== "ADMIN") return Response.json({ error: "Only workspace owners and admins can see AI usage." }, { status: 403 });

  const q = new URL(req.url).searchParams;
  const all = platform && q.get("scope") === "all";
  const size = Math.min(Math.max(Number(q.get("size")) || 25, 10), 100);
  const page = Math.max(Number(q.get("page")) || 1, 1);
  const days = Number(q.get("days")) || 0;
  const app = q.get("app");
  const term = (q.get("q") ?? "").trim().slice(0, 100);

  const where: Prisma.AiUsageWhereInput = {
    ...(all ? {} : { workspaceId: ws.id }),
    ...(days > 0 ? { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } } : {}),
    ...(app === "suite" || app === "workspace" ? { app } : {}),
  };
  if (term) {
    const [users, projects] = await Promise.all([
      db.user.findMany({ where: { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] }, select: { id: true }, take: 200 }),
      db.project.findMany({ where: { name: { contains: term, mode: "insensitive" }, ...(all ? {} : { workspaceId: ws.id }) }, select: { id: true }, take: 200 }),
    ]);
    where.OR = [
      { feature: { contains: term, mode: "insensitive" } },
      { model: { contains: term, mode: "insensitive" } },
      { requestId: { contains: term } },
      ...(users.length ? [{ userId: { in: users.map((u) => u.id) } }] : []),
      ...(projects.length ? [{ projectId: { in: projects.map((p) => p.id) } }] : []),
    ];
  }

  const csv = q.get("format") === "csv";
  const [total, rows, sums, byFeature, byModel] = await Promise.all([
    db.aiUsage.count({ where }),
    db.aiUsage.findMany({ where, orderBy: { createdAt: "desc" }, skip: csv ? 0 : (page - 1) * size, take: csv ? 20_000 : size }),
    db.aiUsage.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, webSearches: true, costMicros: true } }),
    db.aiUsage.groupBy({ by: ["feature"], where, _count: true, _sum: { costMicros: true, inputTokens: true, outputTokens: true }, orderBy: { _sum: { costMicros: "desc" } }, take: 12 }),
    db.aiUsage.groupBy({ by: ["model"], where, _count: true, _sum: { costMicros: true }, orderBy: { _sum: { costMicros: "desc" } }, take: 8 }),
  ]);

  // Names for the people, projects and workspaces on this page.
  const ids = (k: "userId" | "projectId" | "workspaceId") => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
  const [people, projects, spaces] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids("userId") } }, select: { id: true, name: true, email: true } }),
    db.project.findMany({ where: { id: { in: ids("projectId") } }, select: { id: true, name: true } }),
    all ? db.workspace.findMany({ where: { id: { in: ids("workspaceId") } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const person = new Map(people.map((p) => [p.id, p]));
  const project = new Map(projects.map((p) => [p.id, p.name]));
  const space = new Map(spaces.map((s) => [s.id, s.name]));
  const out = rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    user: r.userId ? { name: person.get(r.userId)?.name ?? null, email: person.get(r.userId)?.email ?? null } : null,
    project: r.projectId ? { id: r.projectId, name: project.get(r.projectId) ?? "(deleted project)" } : null,
    workspace: all && r.workspaceId ? space.get(r.workspaceId) ?? r.workspaceId : null,
    app: r.app,
    feature: r.feature,
    model: r.model,
    status: r.status,
    input: r.inputTokens,
    output: r.outputTokens,
    cacheWrite: r.cacheWriteTokens,
    cacheRead: r.cacheReadTokens,
    searches: r.webSearches,
    cost: usd(r.costMicros),
    ms: r.ms,
    requestId: r.requestId,
  }));

  if (csv) {
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["time", "workspace", "person", "email", "project", "app", "feature", "model", "status", "input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens", "web_searches", "cost_usd", "ms", "request_id"];
    const lines = out.map((r) =>
      [r.at, r.workspace ?? ws.name, r.user?.name, r.user?.email, r.project?.name, r.app, r.feature, r.model, r.status, r.input, r.output, r.cacheWrite, r.cacheRead, r.searches, r.cost.toFixed(6), r.ms, r.requestId].map(cell).join(","),
    );
    return new Response([head.join(","), ...lines].join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ai-usage-${new Date().toISOString().slice(0, 10)}.csv"` },
    });
  }

  return Response.json({
    rows: out,
    total,
    page,
    size,
    canAll: platform,
    totals: {
      calls: sums._count,
      input: sums._sum.inputTokens ?? 0,
      output: sums._sum.outputTokens ?? 0,
      cacheWrite: sums._sum.cacheWriteTokens ?? 0,
      cacheRead: sums._sum.cacheReadTokens ?? 0,
      searches: sums._sum.webSearches ?? 0,
      cost: usd(sums._sum.costMicros ?? 0),
    },
    byFeature: byFeature.map((f) => ({ feature: f.feature, calls: f._count, cost: usd(f._sum.costMicros ?? 0), input: f._sum.inputTokens ?? 0, output: f._sum.outputTokens ?? 0 })),
    byModel: byModel.map((f) => ({ model: f.model, calls: f._count, cost: usd(f._sum.costMicros ?? 0) })),
  });
}

export const GET = route(GET_);
