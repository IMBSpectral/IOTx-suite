import { db } from "@/lib/db";
import { audit, inviteAllowed } from "@/lib/workspace-security";
import { requireUser, requireProject } from "@/lib/workspace";
import type { Role } from "@prisma/client";
import { route } from "@/lib/route";
import { notify } from "@/lib/sharing";

async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);

  const rows = await db.collaborator.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "asc" },
  });

  const users = await db.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, name: true, email: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return Response.json({
    visibility: project.visibility,
    collaborators: rows.map((r) => ({
      id: r.id,
      role: r.role,
      userId: r.userId,
      name: byId.get(r.userId)?.name ?? null,
      email: byId.get(r.userId)?.email ?? "",
    })),
  });
}

async function POST_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "admin");

  const { email, role } = (await req.json()) as { email?: string; role?: Role };
  const address = email?.trim().toLowerCase();
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return Response.json({ error: "A valid email is required" }, { status: 400 });
  }

  const invitee = await db.user.upsert({
    where: { email: address },
    update: {},
    create: { email: address },
  });

  const existing = await db.collaborator.findUnique({
    where: { projectId_userId: { projectId: id, userId: invitee.id } },
  });
  if (existing) return Response.json({ error: "Already shared" }, { status: 409 });

  const [ws, member] = await Promise.all([
    db.workspace.findUnique({ where: { id: project.workspaceId } }),
    db.membership.findUnique({ where: { userId_workspaceId: { userId: invitee.id, workspaceId: project.workspaceId } } }),
  ]);
  if (!member && ws && !ws.allowExternalCollaborators) {
    return Response.json(
      { error: "This workspace only allows sharing with its members." },
      { status: 400 },
    );
  }

  if (!member && ws && !inviteAllowed(ws, address)) {
    return Response.json({ error: "Only verified-domain emails can be invited." }, { status: 403 });
  }

  await db.collaborator.create({
    data: {
      projectId: id,
      userId: invitee.id,
      role: role === "VIEWER" || role === "ADMIN" ? role : "MEMBER",
    },
  });
  await audit(project.workspaceId, user.id, "project.shared", `Shared "${project.name}" with ${address}`, id);
  await notify([invitee.id], {
    projectId: id,
    kind: "project_invite",
    title: `${user.name ?? user.email ?? "Someone"} shared ${project.name} with you`,
    href: `/projects/${id}`,
  });
  return Response.json({ ok: true }, { status: 201 });
}

async function DELETE_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "admin");

  const { collaboratorId } = (await req.json()) as { collaboratorId?: string };
  if (!collaboratorId) {
    return Response.json({ error: "collaboratorId is required" }, { status: 400 });
  }

  const row = await db.collaborator.findUnique({ where: { id: collaboratorId } });
  if (!row || row.projectId !== id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  await db.collaborator.delete({ where: { id: collaboratorId } });
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { name: true, workspaceId: true } });
  await audit(p.workspaceId, user.id, "project.unshared", `Removed a collaborator from "${p.name}"`, id);
  return Response.json({ ok: true });
}

async function PATCH_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "admin");

  const body = (await req.json()) as { visibility?: string; collaboratorId?: string; role?: Role };
  if (body.collaboratorId) {
    const row = await db.collaborator.findUnique({ where: { id: body.collaboratorId } });
    if (!row || row.projectId !== id) return Response.json({ error: "Not found" }, { status: 404 });
    if (!body.role || !["ADMIN", "MEMBER", "VIEWER"].includes(body.role)) {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }
    await db.collaborator.update({ where: { id: row.id }, data: { role: body.role } });
    return Response.json({ ok: true });
  }
  const { visibility } = body;
  if (!["PRIVATE", "UNLISTED", "PUBLIC"].includes(visibility ?? "")) {
    return Response.json({ error: "Invalid visibility" }, { status: 400 });
  }

  const project = await db.project.update({
    where: { id },
    data: { visibility: visibility as "PRIVATE" | "UNLISTED" | "PUBLIC" },
  });
  return Response.json({ visibility: project.visibility });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
