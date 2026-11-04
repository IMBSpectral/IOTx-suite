import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { readConnectorLog } from "@/lib/connector-log";

/** Connector usage per connection (30 days) and the request log, optionally for one project. */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  return Response.json(await readConnectorLog(ws.id, { projectId: new URL(req.url).searchParams.get("projectId") }));
}

export const GET = route(GET_);
