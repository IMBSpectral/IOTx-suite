import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";

async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);

  const entries = await db.creditEntry.findMany({
    where: { workspaceId: ws.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const spentThisMonth = await db.creditEntry.aggregate({
    where: {
      workspaceId: ws.id,
      delta: { lt: 0 },
      createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
    },
    _sum: { delta: true },
  });

  return Response.json({
    balance: ws.creditBalance,
    monthlyCredits: ws.monthlyCredits,
    plan: ws.plan,
    spentThisMonth: Math.abs(spentThisMonth._sum.delta ?? 0),
    entries: entries.map((e) => ({
      id: e.id,
      delta: e.delta,
      reason: e.reason,
      at: e.createdAt.toISOString(),
    })),
  });
}

export const GET = route(GET_);
