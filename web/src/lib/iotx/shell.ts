import { cache } from "react";
import { db } from "../db";
import { currentWorkspace } from "../workspace";
import { canManageRoles, effectiveForRequest } from "./permissions";
import { loadAppearance } from "./appearance-server";
import type { PermsData } from "@/components/iotx/PermsProvider";
import { isPlatformAdmin } from "../platform-admin";
import { isFleetControl } from "../fleet";

/**
 * Everything the IOTx Suite shell needs for one request: who is signed in,
 * the active workspace, what they can do there (following "Preview as"),
 * their saved appearance and recent AI chats. Cached per request, so the
 * layout and the page share one lookup.
 */
export const shellData = cache(async (userId: string, workspaceId?: string) => {
  let ws;
  try {
    // A server-to-server caller (GET /api/iotx/shell) names the workspace; it must be one of theirs.
    ws = workspaceId
      ? (await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, include: { workspace: true } }))?.workspace
      : await currentWorkspace(userId);
    if (!ws) return null;
  } catch {
    return null;
  }
  const [e, canManage, appearance, user, memberships, chats] = await Promise.all([
    effectiveForRequest(userId, ws.id),
    canManageRoles(userId, ws.id),
    loadAppearance(userId),
    db.user.findUnique({ where: { id: userId }, select: { name: true, email: true, image: true } }),
    db.membership.findMany({ where: { userId }, include: { workspace: { select: { id: true, name: true, plan: true } } }, orderBy: { createdAt: "asc" } }),
    db.workspaceChat.findMany({ where: { userId, workspaceId: ws.id }, orderBy: { updatedAt: "desc" }, take: 6, select: { id: true, title: true } }),
  ]);
  const perms: PermsData | null = e
    ? { keys: e.keys, apps: e.apps, limits: e.limits, isOwner: e.isOwner, plan: e.plan, roles: e.roles, preview: e.preview, canManage }
    : null;
  return {
    perms,
    appearance,
    user: { name: user?.name ?? null, email: user?.email ?? "", image: user?.image ?? null },
    workspace: { id: ws.id, name: ws.name, plan: ws.plan },
    workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, plan: m.workspace.plan, role: m.role })),
    recentChats: chats,
    // Admin → Deployments (every server, its deploys and AI usage): the control server's platform admins.
    fleet: isFleetControl() && isPlatformAdmin(user?.email),
  };
});

export type ShellData = NonNullable<Awaited<ReturnType<typeof shellData>>>;
