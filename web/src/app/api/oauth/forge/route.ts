import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { CloudError } from "@/lib/cloud";
import { allowedRedirect, issueCode } from "@/lib/forge-identity";

/** The consent page's Continue: a single-use code for the app, bound to its address. */
async function POST_(req: Request) {
  const user = await requireUser();
  const b = (await req.json().catch(() => ({}))) as { projectId?: string; redirectUri?: string };
  const target = b.projectId && b.redirectUri ? await allowedRedirect(b.projectId, b.redirectUri) : null;
  if (!target) return Response.json({ error: "This sign-in request isn't for an address the app uses." }, { status: 400 });
  try {
    return Response.json({ code: await issueCode(b.projectId!, user.id, target) });
  } catch (e) {
    if (e instanceof CloudError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const POST = route(POST_);
