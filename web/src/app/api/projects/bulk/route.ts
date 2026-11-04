import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { requirePerm } from "@/lib/iotx/permissions";
import { purgeProjectData } from "@/lib/purge";
import { route } from "@/lib/route";
import { visibleTo } from "@/lib/projects";

/**
 * Bulk actions from the dashboard's selection bar. Only projects in the
 * caller's current workspace are touched, whatever ids are sent.
 */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const { action, ids, folderId, ownerId, workspaceId } = (await req.json().catch(() => ({}))) as {
    action?: string;
    ownerId?: string;
    workspaceId?: string;
    ids?: string[];
    folderId?: string | null;
  };
  if (!Array.isArray(ids) || ids.length === 0) return Response.json({ error: "Nothing selected" }, { status: 400 });
  if (action === "delete" || action === "purge") await requirePerm(user.id, ws.id, "builder.project.delete");
  if (action === "move" || action === "transfer" || action === "moveWorkspace") await requirePerm(user.id, ws.id, "builder.project.transfer");

  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
  });
  const isAdmin = membership?.role === "OWNER" || membership?.role === "ADMIN";
  // Deleting, purging, restoring and unpublishing belong to admins and each project's creator.
  const destructive = ["delete", "purge", "restore", "unpublish", "transfer", "moveWorkspace"].includes(action ?? "");
  if ((action === "transfer" || action === "moveWorkspace") && !isAdmin) {
    return Response.json({ error: "Only workspace owners and admins can do that." }, { status: 403 });
  }
  const owned = await db.project.findMany({
    where: {
      id: { in: ids.slice(0, 200) },
      workspaceId: ws.id,
      ...(await visibleTo(user.id, ws.id)),
      ...(destructive && !isAdmin ? { createdById: user.id } : {}),
    },
    select: { id: true },
  });
  const valid = owned.map((p) => p.id);
  const where = { id: { in: valid } };

  switch (action) {
    case "delete":
      await db.project.updateMany({ where, data: { deletedAt: new Date() } });
      break;
    case "restore":
      await db.project.updateMany({ where, data: { deletedAt: null } });
      break;
    case "purge": {
      // Permanent: only for projects already in Recently deleted.
      const gone = await db.project.findMany({ where: { ...where, deletedAt: { not: null } }, select: { id: true } });
      await db.project.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
      for (const g of gone) await purgeProjectData(g.id);
      return Response.json({ ok: true, count: gone.length });
    }
    case "move": {
      if (folderId) {
        const f = await db.folder.findFirst({ where: { id: folderId, workspaceId: ws.id } });
        if (!f) return Response.json({ error: "Folder not found" }, { status: 404 });
      }
      await db.project.updateMany({ where, data: { folderId: folderId || null } });
      break;
    }
    case "unpublish":
      await db.project.updateMany({ where, data: { publishedSha: null, publishedAt: null } });
      break;
    case "star":
      await db.star.createMany({
        data: valid.map((projectId) => ({ projectId, userId: user.id })),
        skipDuplicates: true,
      });
      break;
    // Hide from my lists (just for me) or show again.
    case "hide":
      await db.projectHide.createMany({ data: valid.map((projectId) => ({ projectId, userId: user.id })), skipDuplicates: true });
      break;
    case "unhide":
      await db.projectHide.deleteMany({ where: { userId: user.id, projectId: { in: valid } } });
      break;
    case "unstar":
      await db.star.deleteMany({ where: { userId: user.id, projectId: { in: valid } } });
      break;
    case "transfer": {
      // Change owner: the new owner must be a member of this workspace.
      const m = ownerId
        ? await db.membership.findUnique({ where: { userId_workspaceId: { userId: ownerId, workspaceId: ws.id } } })
        : null;
      if (!m) return Response.json({ error: "Choose a member of this workspace." }, { status: 400 });
      await db.project.updateMany({ where, data: { createdById: ownerId } });
      break;
    }
    case "moveWorkspace": {
      // Collaborators come along; folders don't exist across workspaces.
      const target = workspaceId
        ? await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId } } })
        : null;
      if (!target || target.workspaceId === ws.id || (target.role !== "OWNER" && target.role !== "ADMIN")) {
        return Response.json({ error: "You need to be an owner or admin of the destination workspace." }, { status: 403 });
      }
      await db.project.updateMany({ where, data: { workspaceId: target.workspaceId, folderId: null } });
      break;
    }
    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
  return Response.json({ ok: true, count: valid.length });
}

export const POST = route(POST_);
