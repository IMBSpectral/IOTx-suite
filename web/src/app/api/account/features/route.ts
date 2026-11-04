import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { featuresTried } from "@/lib/features-tried";

/** The "Features tried" checklist for the dashboard. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  return Response.json(await featuresTried(user.id, ws.id));
}

export const GET = route(GET_);
