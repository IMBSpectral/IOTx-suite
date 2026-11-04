import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { ClaimError, claimableWorkspaces, claimWorkspace } from "@/lib/workspace-claims";

/** Workspaces you can join (or ask to join) through your email's verified domain. */
async function GET_() {
  const user = await requireUser();
  return Response.json({ workspaces: await claimableWorkspaces(user.id) });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const { workspaceId } = (await req.json().catch(() => ({}))) as { workspaceId?: string };
  try {
    return Response.json({ ok: true, ...(await claimWorkspace(user.id, workspaceId ?? "")) });
  } catch (e) {
    if (e instanceof ClaimError) return Response.json({ error: e.message }, { status: 403 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
