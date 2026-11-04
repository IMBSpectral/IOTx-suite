import { db } from "@/lib/db";
import { audit } from "@/lib/workspace-security";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { inviteLinkUrl, linkStatus, newToken, previewLinkUrl } from "@/lib/sharing";

type Ctx = { params: Promise<{ id: string }> };

/** Everything the share dialog shows: people, access, invite link, preview links, requests. */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  const manage = project.access === "admin";

  const [collabs, members, links, requests, ws] = await Promise.all([
    db.collaborator.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } }),
    db.membership.findMany({ where: { workspaceId: project.workspaceId }, select: { userId: true } }),
    manage
      ? db.previewLink.findMany({ where: { projectId: id, revokedAt: null }, orderBy: { createdAt: "desc" } })
      : Promise.resolve([]),
    manage
      ? db.accessRequest.findMany({ where: { projectId: id, status: "PENDING" }, orderBy: { createdAt: "asc" } })
      : Promise.resolve([]),
    db.workspace.findUnique({ where: { id: project.workspaceId }, select: { allowExternalCollaborators: true } }),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));
  const users = await db.user.findMany({
    where: { id: { in: [...collabs.map((c) => c.userId), ...requests.map((r) => r.userId)] } },
    select: { id: true, name: true, email: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return Response.json({
    access: project.access,
    canManage: manage,
    isCollaborator: collabs.some((c) => c.userId === user.id),
    restricted: project.restricted,
    allowGuestComments: project.allowGuestComments,
    allowExternal: ws?.allowExternalCollaborators ?? true,
    inviteLink:
      project.linkAccess && project.linkToken
        ? { access: project.linkAccess, url: inviteLinkUrl(project.linkToken) }
        : null,
    collaborators: collabs.map((c) => ({
      id: c.id,
      userId: c.userId,
      role: c.role,
      name: byId.get(c.userId)?.name ?? null,
      email: byId.get(c.userId)?.email ?? "",
      external: !memberIds.has(c.userId),
      you: c.userId === user.id,
    })),
    previewLinks: links.map((l) => ({
      id: l.id,
      name: l.name,
      url: previewLinkUrl(l.token),
      expiresAt: l.expiresAt,
      hasPassword: !!l.passwordHash,
      allowComments: l.allowComments,
      views: l.views,
      status: linkStatus(l),
      createdAt: l.createdAt,
    })),
    requests: requests.map((r) => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      createdAt: r.createdAt,
      name: byId.get(r.userId)?.name ?? null,
      email: byId.get(r.userId)?.email ?? "",
    })),
  });
}

/** Access settings: restricted, invite link on/off/role/reset, guest comments. */
async function PATCH_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "admin");
  const body = (await req.json()) as {
    restricted?: boolean;
    inviteLink?: "off" | "view" | "edit";
    resetInviteLink?: boolean;
    allowGuestComments?: boolean;
  };
  const data: Record<string, unknown> = {};

  if (typeof body.restricted === "boolean") {
    // Only owners restrict: an admin collaborator can't lock the workspace out.
    const m = await db.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: project.workspaceId } },
    });
    if (m?.role !== "OWNER" && m?.role !== "ADMIN") {
      return Response.json({ error: "Only workspace owners and admins can restrict a project." }, { status: 403 });
    }
    data.restricted = body.restricted;
  }
  if (body.inviteLink) {
    if (body.inviteLink === "off") data.linkAccess = null;
    else {
      const ws = await db.workspace.findUnique({ where: { id: project.workspaceId } });
      if (!ws?.allowExternalCollaborators) {
        return Response.json(
          { error: "Invite links are off because this workspace doesn't allow external collaborators." },
          { status: 400 },
        );
      }
      data.linkAccess = body.inviteLink;
      if (!project.linkToken) data.linkToken = newToken(24);
    }
  }
  if (body.resetInviteLink) data.linkToken = newToken(24);
  if (typeof body.allowGuestComments === "boolean") data.allowGuestComments = body.allowGuestComments;

  await db.project.update({ where: { id }, data });
  const what = [
    typeof body.restricted === "boolean" && (body.restricted ? "restricted it" : "opened it to the workspace"),
    body.inviteLink && `invite link ${body.inviteLink}`,
    body.resetInviteLink && "reset the invite link",
    typeof body.allowGuestComments === "boolean" && `guest comments ${body.allowGuestComments ? "on" : "off"}`,
  ].filter(Boolean);
  if (what.length) await audit(project.workspaceId, user.id, "project.sharing", `"${project.name}": ${what.join(", ")}`, id);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
