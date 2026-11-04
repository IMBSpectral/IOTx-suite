import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { draftDiff } from "@/lib/branch-diff";

type Ctx = { params: Promise<{ id: string; draftId: string }> };

/** The draft's changes against the commit it started from, file by file. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id, draftId } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  try {
    return Response.json(await draftDiff(id, draftId));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Couldn't diff the draft." }, { status: 404 });
  }
}

export const GET = route(GET_);
