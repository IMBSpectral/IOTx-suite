import { requirePerm } from "@/lib/iotx/permissions";
import { requireUser, currentWorkspace, requireProject, requireRole } from "@/lib/workspace";
import { audit } from "@/lib/workspace-security";
import { route } from "@/lib/route";
import { CATALOG, connect, ConnectorError, disconnect, listConnections, recheck } from "@/lib/connectors";
import { DefError, deleteCustomDef, listCustomDefs, saveCustomDef, toConnectorDef } from "@/lib/connector-defs";
import { connectorApproval, pendingConnectorRequests, requestConnector, setConnectorApproval } from "@/lib/connector-requests";
import { notify } from "@/lib/sharing";
import { db } from "@/lib/db";

/** The catalog and this workspace's connections (optionally those a project can use). */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
  if (projectId) await requireProject(user.id, projectId);
  return Response.json({
    catalog: [...CATALOG, ...(await listCustomDefs(ws.id)).map(toConnectorDef)].map((c) => ({
      kind: c.kind,
      name: c.name,
      description: c.description,
      type: c.type,
      docs: c.docs ?? null,
      custom: "custom" in c,
      fields: c.fields?.map((f) => ({ key: f.key, label: f.label, secret: f.secret, placeholder: f.placeholder ?? "" })) ?? [],
    })),
    customDefs: await listCustomDefs(ws.id),
    connections: await listConnections(ws.id, projectId),
    approval: await connectorApproval(ws.id),
    canManage: ["OWNER", "ADMIN"].includes((await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } } }))?.role ?? ""),
    myRequests: (await pendingConnectorRequests(ws.id)).filter((r) => r.userId === user.id),
  });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const body = (await req.json().catch(() => ({}))) as {
    action?: "connect" | "check" | "disconnect" | "saveDef" | "deleteDef" | "policy";
    kind?: string;
    label?: string;
    values?: Record<string, string>;
    scope?: "workspace" | "project";
    projectId?: string;
    id?: string;
  };
  try {
    switch (body.action) {
      case "connect": {
        await requirePerm(user.id, ws.id, body.kind === "github" ? "builder.github" : "builder.connectors");
        if (body.scope === "project") {
          if (!body.projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
          await requireProject(user.id, body.projectId, "edit");
        }
        // With approval on, a member's connect waits for an admin (action center); owners and admins connect directly.
        const role = (await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } } }))?.role;
        if (role !== "OWNER" && role !== "ADMIN" && (await connectorApproval(ws.id))) {
          const r = await requestConnector(ws.id, user.id, {
            kind: body.kind ?? "",
            label: body.label,
            values: body.values ?? {},
            scope: body.scope === "project" ? "project" : "workspace",
            projectId: body.projectId,
            reason: (body as { reason?: string }).reason,
          });
          const admins = await db.membership.findMany({ where: { workspaceId: ws.id, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } });
          await notify(admins.map((a) => a.userId), { kind: "connector_request", title: `${user.email ?? "A member"} asks to connect ${r.name}`, href: "/settings/actions" });
          await audit(ws.id, user.id, "connector.requested", `Asked to connect ${r.name}`, r.projectId);
          return Response.json({ ok: true, requested: true, id: r.id, message: `Sent to your workspace admins: ${r.name} connects once one of them approves.` }, { status: 202 });
        }
        const c = await connect({
          workspaceId: ws.id,
          kind: body.kind ?? "",
          label: body.label,
          values: body.values ?? {},
          scope: body.scope === "project" ? "project" : "workspace",
          projectId: body.projectId,
        });
        await audit(ws.id, user.id, "connector.connected", `Connected ${body.kind} (${c.label})`, body.scope === "project" ? body.projectId : null);
        return Response.json({ ok: true, id: c.id, label: c.label }, { status: 201 });
      }
      case "check":
        return Response.json(await recheck(ws.id, body.id ?? ""));
      case "policy": {
        await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
        const on = (body as { approval?: boolean }).approval === true;
        await setConnectorApproval(ws.id, on);
        await audit(ws.id, user.id, "workspace.settings", on ? "Members now need approval to connect tools" : "Members can connect tools themselves");
        return Response.json({ ok: true, approval: on });
      }
      case "saveDef":
      case "deleteDef": {
        await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
        if (body.action === "deleteDef") {
          await deleteCustomDef(ws.id, body.kind ?? "");
          return Response.json({ ok: true });
        }
        return Response.json({ def: await saveCustomDef(ws.id, (body as { def?: Record<string, unknown> }).def ?? {}) }, { status: 201 });
      }
      case "disconnect":
        await requirePerm(user.id, ws.id, "builder.connectors");
        await disconnect(ws.id, body.id ?? "");
        await audit(ws.id, user.id, "connector.disconnected", "Disconnected a connector");
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof DefError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof ConnectorError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
