import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { acknowledge, actionCenter } from "@/lib/action-center";
import { decideConnectorRequest } from "@/lib/connector-requests";
import { ConnectorError } from "@/lib/connectors";
import { audit } from "@/lib/workspace-security";
import { notify } from "@/lib/sharing";

/** Everything waiting on an admin in this workspace. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  return Response.json(await actionCenter(ws.id));
}

/** acknowledge {id}: an anomaly is seen and dealt with · decideConnector {id, approve} */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; approve?: boolean };
  if (!b.id || b.id.length > 300) return Response.json({ error: "Unknown action" }, { status: 400 });
  if (b.action === "decideConnector") {
    try {
      const r = await decideConnectorRequest(ws.id, b.id, b.approve === true);
      await audit(ws.id, user.id, b.approve ? "connector.connected" : "connector.declined", `${b.approve ? "Approved" : "Declined"} ${r.request.name} for a member`, r.request.projectId);
      await notify([r.request.userId], {
        kind: "connector_request",
        title: b.approve ? `${r.request.name} is connected` : `Your request to connect ${r.request.name} was declined`,
        ...(r.request.projectId ? { projectId: r.request.projectId } : {}),
      });
      return Response.json({ ok: true, connection: r.connection });
    } catch (e) {
      if (e instanceof ConnectorError) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
  }
  if (b.action !== "acknowledge") return Response.json({ error: "Unknown action" }, { status: 400 });
  await acknowledge(ws.id, b.id, user.id);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
