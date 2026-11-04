import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { PROJECTS_ROOT } from "@/lib/paths";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { FREE_DAILY_CHATS, freeChatsUsedToday, grant, monthStart, spentThisMonth } from "@/lib/credits";
import { VOICE_DAILY_SECONDS, voiceUsedToday } from "@/lib/voice";
import { creditSummary } from "@/lib/billing-cycle";

const PLAN_CREDITS = { FREE: 30, PRO: 500, BUSINESS: 2000 } as const;
const TOPUPS = [50, 100, 250, 500];

/** Billing overview: balance, plan, limits and where this month's credits went. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const me = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } } });
  const isAdmin = me?.role === "OWNER" || me?.role === "ADMIN";
  const since = monthStart();
  // Expired credits weren't spent, so they stay out of usage.
  const spent = { workspaceId: ws.id, delta: { lt: 0 }, reason: { not: "EXPIRED" as const }, createdAt: { gte: since } };
  const credits = await creditSummary(ws.id);

  const [byCategory, byProject, byUser, recent, limits, members, projects] = await Promise.all([
    db.creditEntry.groupBy({ by: ["category"], where: spent, _sum: { delta: true } }),
    db.creditEntry.groupBy({ by: ["projectId"], where: spent, _sum: { delta: true } }),
    db.creditEntry.groupBy({ by: ["userId"], where: spent, _sum: { delta: true } }),
    db.creditEntry.findMany({
      where: { workspaceId: ws.id, reason: { not: "EXPIRED" }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      select: { delta: true, createdAt: true },
    }),
    db.spendLimit.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "asc" } }),
    db.membership.findMany({ where: { workspaceId: ws.id }, include: { user: { select: { id: true, name: true, email: true } } } }),
    db.project.findMany({ where: { workspaceId: ws.id, deletedAt: null }, select: { id: true, name: true } }),
  ]);
  // Connector and MCP requests are metered as requests, not credits.
  const requestRows = await db.creditEntry.groupBy({
    by: ["category"],
    where: { workspaceId: ws.id, category: { startsWith: "connector:" }, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const userName = new Map(members.map((m) => [m.user.id, m.user.name ?? m.user.email ?? "Member"]));
  const abs = (n: number | null) => Math.abs(n ?? 0);

  const daily = new Map<string, number>();
  for (let i = 29; i >= 0; i--) daily.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), 0);
  for (const e of recent) {
    const day = e.createdAt.toISOString().slice(0, 10);
    if (e.delta < 0 && daily.has(day)) daily.set(day, daily.get(day)! - e.delta);
  }

  return Response.json({
    isAdmin,
    plan: ws.plan,
    balance: credits.balance,
    monthlyCredits: ws.monthlyCredits,
    rollover: { credits: credits.rollover, expiresAt: credits.rolloverExpiresAt, nudge: credits.expiryNudge },
    nextRefill: credits.nextRefill,
    // Contract status: the current billing period and any enterprise enquiry.
    period: { start: ws.periodStart.toISOString(), end: credits.nextRefill },
    salesRequestedAt: ws.salesRequestedAt?.toISOString() ?? null,
    meteredTermsAccepted: !!ws.meteredTermsAt,
    autoTopup: { on: ws.autoTopupOn, amount: ws.autoTopupLimit },
    workspaceLimit: ws.monthlySpendLimit,
    spentThisMonth: await spentThisMonth(ws.id),
    topups: TOPUPS,
    // Free allowances ("grants"): what costs nothing, and how much is left today.
    grants: {
      chats: { daily: FREE_DAILY_CHATS, usedToday: await freeChatsUsedToday(ws.id, user.id) },
      voice: { dailyMinutes: Math.round(VOICE_DAILY_SECONDS / 60), usedMinutes: Math.round((await voiceUsedToday(user.id)) / 60) },
      monthlyCredits: ws.monthlyCredits,
      securityFixes: true,
    },
    connectorRequests: requestRows.map((r) => ({ kind: (r.category ?? "").slice("connector:".length), requests: r._count._all })),
    usage: {
      byCategory: Object.fromEntries(byCategory.map((r) => [r.category ?? "other", abs(r._sum.delta)])),
      byProject: byProject
        .map((r) => ({ id: r.projectId, name: projectName.get(r.projectId ?? "") ?? "Deleted or other", credits: abs(r._sum.delta) }))
        .sort((a, b) => b.credits - a.credits)
        .slice(0, 10),
      byUser: byUser
        .map((r) => ({ id: r.userId, name: userName.get(r.userId ?? "") ?? "Unattributed", credits: abs(r._sum.delta) }))
        .sort((a, b) => b.credits - a.credits),
      daily: [...daily].map(([day, credits]) => ({ day, credits })),
    },
    limits: await Promise.all(
      limits.map(async (l) => ({
        id: l.id,
        scope: l.scope,
        targetId: l.targetId,
        name: (l.scope === "user" ? userName.get(l.targetId) : projectName.get(l.targetId)) ?? "Removed",
        monthly: l.monthly,
        spent: await spentThisMonth(ws.id, l.scope === "user" ? { userId: l.targetId } : { projectId: l.targetId }),
      })),
    ),
    members: members.map((m) => ({ id: m.user.id, name: m.user.name ?? m.user.email })),
    projects,
  });
}

/**
 * Billing changes (owners/admins). There is no payment provider locally:
 * top-ups and plan changes are applied directly, in test mode.
 */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const body = (await req.json()) as {
    action?: string;
    amount?: number;
    on?: boolean;
    monthly?: number | null;
    scope?: string;
    targetId?: string;
    id?: string;
    plan?: keyof typeof PLAN_CREDITS;
    acceptTerms?: boolean;
    company?: string;
    seats?: number;
    message?: string;
  };
  const positive = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 1_000_000;

  switch (body.action) {
    case "topup":
      if (!TOPUPS.includes(body.amount ?? 0)) return Response.json({ error: "Choose a top-up amount." }, { status: 400 });
      await grant(ws.id, body.amount!, "TOPUP");
      break;
    case "autoTopup":
      if (body.on && !positive(body.amount)) return Response.json({ error: "Set an amount to add." }, { status: 400 });
      // Auto top-up is metered usage: an admin accepts its terms once.
      if (body.on && !ws.meteredTermsAt) {
        if (!body.acceptTerms) return Response.json({ error: "Accept the usage terms first.", needsTerms: true }, { status: 409 });
        await db.workspace.update({ where: { id: ws.id }, data: { meteredTermsAt: new Date() } });
      }
      await db.workspace.update({
        where: { id: ws.id },
        data: { autoTopupOn: !!body.on, autoTopupLimit: body.on ? body.amount! : ws.autoTopupLimit },
      });
      break;
    case "workspaceLimit":
      if (body.monthly !== null && !positive(body.monthly)) return Response.json({ error: "Enter a whole number of credits." }, { status: 400 });
      await db.workspace.update({ where: { id: ws.id }, data: { monthlySpendLimit: body.monthly } });
      break;
    case "setLimit": {
      if (body.scope !== "user" && body.scope !== "project") return Response.json({ error: "Invalid scope" }, { status: 400 });
      if (!positive(body.monthly)) return Response.json({ error: "Enter a whole number of credits." }, { status: 400 });
      const ok =
        body.scope === "user"
          ? await db.membership.count({ where: { workspaceId: ws.id, userId: body.targetId } })
          : await db.project.count({ where: { workspaceId: ws.id, id: body.targetId } });
      if (!ok) return Response.json({ error: "Not found in this workspace" }, { status: 404 });
      await db.spendLimit.upsert({
        where: { workspaceId_scope_targetId: { workspaceId: ws.id, scope: body.scope, targetId: body.targetId! } },
        create: { workspaceId: ws.id, scope: body.scope, targetId: body.targetId!, monthly: body.monthly! },
        update: { monthly: body.monthly! },
      });
      break;
    }
    case "removeLimit":
      await db.spendLimit.deleteMany({ where: { id: body.id, workspaceId: ws.id } });
      break;
    case "contactSales": {
      // Enterprise enquiries are kept for whoever runs Forge (_forge/sales-requests.jsonl).
      const company = body.company?.trim().slice(0, 120);
      if (!company) return Response.json({ error: "Tell us the company name." }, { status: 400 });
      const entry = { at: new Date().toISOString(), workspaceId: ws.id, workspace: ws.name, userId: user.id, email: user.email, company, seats: Number(body.seats) || null, message: (body.message ?? "").slice(0, 2000) };
      await fs.mkdir(path.join(PROJECTS_ROOT, "_forge"), { recursive: true });
      await fs.appendFile(path.join(PROJECTS_ROOT, "_forge", "sales-requests.jsonl"), JSON.stringify(entry) + "\n");
      await db.workspace.update({ where: { id: ws.id }, data: { salesRequestedAt: new Date() } });
      break;
    }
    case "plan": {
      const plan = body.plan;
      if (!plan || !(plan in PLAN_CREDITS)) return Response.json({ error: "Unknown plan" }, { status: 400 });
      await db.workspace.update({ where: { id: ws.id }, data: { plan, monthlyCredits: PLAN_CREDITS[plan] } });
      break;
    }
    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
