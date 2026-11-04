import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { assertCredits, InsufficientCredits, SpendLimitReached } from "@/lib/credits";
import {
  budgetSuggestions,
  campaignProblems,
  createCampaign,
  decideChangeset,
  draftAdCopy,
  generatePlan,
  launchCampaign,
  MarketingError,
  proposeChanges,
  readStore,
  setActionDone,
  type Campaign,
} from "@/lib/marketing";

type Ctx = { params: Promise<{ id: string }> };

/** The growth plan, campaigns (with what blocks launching) and changesets. */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const s = await readStore(id);
  return Response.json({
    plan: s.plan,
    campaigns: s.campaigns
      .filter((c) => c.status !== "removed")
      .map((c) => ({ ...c, problems: campaignProblems(c), suggestions: budgetSuggestions(c.goal) })),
    changesets: s.changesets.slice(-50).reverse(),
  });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    target?: string;
    actionId?: string;
    done?: boolean;
    campaign?: Partial<Campaign>;
    campaignId?: string;
    changesetId?: string;
    approve?: boolean;
    patch?: Record<string, unknown>;
    summary?: string;
    instruction?: string;
  };
  const who = { workspaceId: project.workspaceId, userId: user.id, projectId: id };
  try {
    switch (body.action) {
      case "plan":
        await assertCredits(project.workspaceId, { userId: user.id, projectId: id });
        return Response.json({ plan: await generatePlan({ ...who, target: body.target ?? "" }) });
      case "action_done":
        return Response.json({ action: await setActionDone(id, body.actionId ?? "", !!body.done) });
      case "create_campaign":
        return Response.json({ campaign: await createCampaign(id, body.campaign ?? {}) }, { status: 201 });
      case "propose":
        return Response.json(
          { changeset: await proposeChanges(id, body.campaignId ?? "", body.summary ?? "", body.patch ?? {}, "user") },
          { status: 201 },
        );
      case "draft_copy":
        await assertCredits(project.workspaceId, { userId: user.id, projectId: id });
        return Response.json(
          { changeset: await draftAdCopy({ ...who, campaignId: body.campaignId ?? "", instruction: body.instruction }) },
          { status: 201 },
        );
      case "decide":
        return Response.json({ changeset: await decideChangeset(id, body.changesetId ?? "", !!body.approve) });
      case "launch":
        await launchCampaign(id, body.campaignId ?? "");
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MarketingError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof InsufficientCredits || e instanceof SpendLimitReached) {
      return Response.json({ error: e.message }, { status: 402 });
    }
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
