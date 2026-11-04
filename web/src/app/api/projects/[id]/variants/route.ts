import { requireProjectPerm } from "@/lib/iotx/permissions";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { assertCredits, InsufficientCredits, SpendLimitReached } from "@/lib/credits";
import { chooseVariant, createVariants, discardVariants, openVariants, VariantError } from "@/lib/variants";

type Ctx = { params: Promise<{ id: string }> };

/** The open set of variants, if any, with each one's state. */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  return Response.json({ group: await openVariants(id) });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.build");
  const body = (await req.json().catch(() => ({}))) as { action?: string; prompt?: string; count?: number; groupId?: string; draftId?: string };
  try {
    switch (body.action ?? "create") {
      case "create":
        await assertCredits(project.workspaceId, { userId: user.id, projectId: id });
        return Response.json({ group: await createVariants(id, user.id, body.prompt ?? "", body.count ?? 3) }, { status: 201 });
      case "choose":
        await chooseVariant(id, body.groupId ?? "", body.draftId ?? "");
        return Response.json({ ok: true });
      case "discard":
        await discardVariants(id, body.groupId ?? "");
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof VariantError || (e instanceof Error && /draft/i.test(e.message))) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof InsufficientCredits || e instanceof SpendLimitReached) return Response.json({ error: e.message }, { status: 402 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
