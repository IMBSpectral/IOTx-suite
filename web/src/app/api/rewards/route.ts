import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { claimReward, RewardError, rewardsFor } from "@/lib/rewards";

/** Bonuses you can earn, what you've earned and claimed, and the workspaces you can claim into. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const workspaces = await db.membership.findMany({ where: { userId: user.id }, select: { workspace: { select: { id: true, name: true } } } });
  return Response.json({ ...(await rewardsFor(user.id)), workspaces: workspaces.map((m) => m.workspace), currentWorkspace: ws.id });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const { rewardId, workspaceId } = (await req.json().catch(() => ({}))) as { rewardId?: string; workspaceId?: string };
  try {
    return Response.json({ ok: true, ...(await claimReward(user.id, rewardId ?? "", workspaceId ?? "")) });
  } catch (e) {
    if (e instanceof RewardError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
