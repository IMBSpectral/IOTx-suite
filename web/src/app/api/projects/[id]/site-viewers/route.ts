import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { audit, inviteAllowed } from "@/lib/workspace-security";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Who can open a non-public published site: people with inherited access
 * (workspace members or admins, project collaborators), which can't be removed
 * here, and people added to the site alone.
 */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "view");
  const [members, collaborators, viewers] = await Promise.all([
    db.membership.findMany({
      where: { workspaceId: project.workspaceId, ...(project.publishAudience === "workspace" ? {} : { role: { in: ["OWNER", "ADMIN"] } }) },
      include: { user: { select: { email: true, name: true } } },
    }),
    project.publishAudience === "workspace"
      ? Promise.resolve([])
      : db.collaborator.findMany({ where: { projectId: id }, select: { userId: true } }),
    db.siteViewer.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } }),
  ]);
  const collabUsers = await db.user.findMany({ where: { id: { in: collaborators.map((c) => c.userId) } }, select: { email: true, name: true } });
  const inherited = [
    ...members.map((m) => ({
      email: m.user.email,
      name: m.user.name,
      source: project.publishAudience === "workspace" ? "Workspace member" : `Workspace ${m.role.toLowerCase()}`,
    })),
    ...collabUsers.map((u) => ({ email: u.email, name: u.name, source: "Project sharing" })),
  ];
  return Response.json({
    audience: project.publishAudience,
    inherited,
    viewers: viewers.map((v) => ({ id: v.id, email: v.email })),
  });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "admin");
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  const address = email?.trim().toLowerCase();
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return Response.json({ error: "Enter an email address." }, { status: 400 });
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: project.workspaceId } });
  if (!inviteAllowed(ws, address)) return Response.json({ error: "Only verified-domain emails can be invited." }, { status: 403 });
  if (await db.siteViewer.findUnique({ where: { projectId_email: { projectId: id, email: address } } })) {
    return Response.json({ error: "Already added." }, { status: 409 });
  }
  const v = await db.siteViewer.create({ data: { projectId: id, email: address, addedById: user.id } });
  await audit(project.workspaceId, user.id, "project.shared", `Let ${address} open the published "${project.name}"`, id);
  return Response.json({ id: v.id, email: v.email }, { status: 201 });
}

async function DELETE_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "admin");
  const { viewerId } = (await req.json().catch(() => ({}))) as { viewerId?: string };
  const { count } = await db.siteViewer.deleteMany({ where: { id: viewerId ?? "", projectId: id } });
  if (!count) return Response.json({ error: "Not found" }, { status: 404 });
  await audit(project.workspaceId, user.id, "project.unshared", `Removed a site viewer from "${project.name}"`, id);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
