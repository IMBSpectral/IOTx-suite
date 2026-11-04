import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import { createShare, deleteShare, grant, hubForProject, listShares, revoke, shareable, updateShare } from "@/lib/datahub";
import { db } from "@/lib/db";
import { visibleTo } from "@/lib/projects";

/**
 * Data Hub management.
 *   GET                       -> { shares, apps }   every share in the workspace, and the apps I can edit
 *   GET ?project=<id>         -> { shareable: { tables, sheets }, hub: { connected, available } }   for one app
 *   POST { action: "share", projectId, kind, ref, name, label?, description?, openToAll? }
 *   POST { action: "update", id, label?, description?, openToAll?, allow? }   allow: an app id to let in
 *   POST { action: "delete", id }
 *   POST { action: "connect", id, projectId }   -> { key }
 *   POST { action: "disconnect", grantId }
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const project = new URL(req.url).searchParams.get("project");
  try {
    if (project) return Response.json({ shareable: await shareable(user.id, project), hub: await hubForProject(project) });
    const where = await visibleTo(user.id, ws.id);
    const apps = await db.project.findMany({ where: { AND: [where, { workspaceId: ws.id, deletedAt: null }] }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 300 });
    return Response.json({ shares: await listShares(user.id, ws.id), apps });
  } catch (e) {
    if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  try {
    switch (b.action) {
      case "share":
        return Response.json({ share: await createShare(user.id, ws.id, b) }, { status: 201 });
      case "update":
        return Response.json({ share: await updateShare(user.id, ws.id, id, b) });
      case "delete":
        await deleteShare(user.id, ws.id, id);
        return Response.json({ ok: true });
      case "connect": {
        const g = await grant(user.id, ws.id, id, String(b.projectId ?? ""));
        return Response.json({ key: g.key });
      }
      case "disconnect":
        await revoke(user.id, ws.id, String(b.grantId ?? ""));
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
