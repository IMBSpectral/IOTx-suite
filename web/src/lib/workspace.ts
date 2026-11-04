import { cookies } from "next/headers";
import { db } from "./db";
import { auth } from "./auth";
import type { Role } from "@prisma/client";
import { blockedFolderIds } from "./folders";
import { noteAiContext } from "./ai-meter";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new Response("Unauthorized", { status: 401 });
  noteAiContext({ userId: session.user.id });
  return session.user as {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

export const WORKSPACE_COOKIE = "forge_ws";

/**
 * The caller's active workspace: the one chosen in the switcher (a cookie,
 * honoured only while they're still a member), else their first.
 */
export async function currentWorkspace(userId: string) {
  let chosen: string | undefined;
  try {
    chosen = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  } catch {
    // Outside a request (worker, scripts): no switcher state.
  }
  const membership =
    (chosen &&
      (await db.membership.findUnique({
        where: { userId_workspaceId: { userId, workspaceId: chosen } },
        include: { workspace: true },
      }))) ||
    (await db.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: { workspace: true },
    }));
  if (!membership) throw new Response("No workspace", { status: 403 });
  noteAiContext({ userId, workspaceId: membership.workspaceId });
  return membership.workspace;
}

/**
 * Authorize a privileged workspace action. Read access comes from membership;
 * anything that changes the workspace or its people needs a role.
 */
export async function requireRole(
  userId: string,
  workspaceId: string,
  allowed: Role[],
) {
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!membership || !allowed.includes(membership.role)) {
    throw new Response("Forbidden", { status: 403 });
  }
  return membership;
}

export type Access = "view" | "edit" | "admin";
const RANK: Record<Access, number> = { view: 1, edit: 2, admin: 3 };

/**
 * What one person may do with a project. Workspace owners and admins manage
 * everything; members edit unless the project (or a folder it sits in) is
 * restricted; invited
 * collaborators get the role they were given.
 */
export async function projectAccess(
  userId: string,
  project: {
    id: string;
    workspaceId: string;
    restricted: boolean;
    folderId?: string | null;
  },
): Promise<Access | null> {
  const [membership, collab] = await Promise.all([
    db.membership.findUnique({
      where: {
        userId_workspaceId: { userId, workspaceId: project.workspaceId },
      },
    }),
    db.collaborator.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
    }),
  ]);
  const fromCollab: Access | null = !collab
    ? null
    : collab.role === "OWNER" || collab.role === "ADMIN"
      ? "admin"
      : collab.role === "MEMBER"
        ? "edit"
        : "view";
  let fromWorkspace: Access | null = null;
  if (membership?.role === "OWNER" || membership?.role === "ADMIN")
    fromWorkspace = "admin";
  else if (
    membership &&
    !project.restricted &&
    !(
      project.folderId &&
      (await blockedFolderIds(userId, project.workspaceId)).includes(
        project.folderId,
      )
    )
  )
    fromWorkspace = membership.role === "VIEWER" ? "view" : "edit";
  if (!fromCollab) return fromWorkspace;
  if (!fromWorkspace) return fromCollab;
  return RANK[fromCollab] >= RANK[fromWorkspace] ? fromCollab : fromWorkspace;
}

/**
 * Authorize access to a project. Every project-scoped route goes through
 * here; `need` is the least access the action requires.
 */
export async function requireProject(
  userId: string,
  projectId: string,
  need: Access = "view",
) {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Response("Not found", { status: 404 });
  const access = await projectAccess(userId, project);
  if (!access || RANK[access] < RANK[need])
    throw new Response("Forbidden", { status: 403 });
  return Object.assign(project, { access });
}
