import { cookies } from "next/headers";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import {
  PREVIEW_COOKIE,
  PermissionError,
  addOverride,
  adminState,
  assignRole,
  canManageRoles,
  createRole,
  deleteRole,
  effectiveForRequest,
  invalidatePerms,
  removeOverride,
  resetRole,
  unassignRole,
  updateRole,
} from "@/lib/iotx/permissions";
import { db } from "@/lib/db";

/**
 * The IOTx Suite permission service over HTTP.
 *   GET                -> { me, canManage }  (what the caller can do; follows "Preview as")
 *   GET ?admin=1       -> the Roles & permissions screen's state (needs admin.roles)
 *   POST { action, … } -> createRole | updateRole | resetRole | deleteRole | assign |
 *                         unassign | override | removeOverride | preview
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("admin")) return Response.json(await adminState(ws.id, user.id));
  } catch (e) {
    if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return Response.json({ me: await effectiveForRequest(user.id, ws.id), canManage: await canManageRoles(user.id, ws.id) });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  try {
    switch (b.action) {
      case "createRole":
        return Response.json({ role: await createRole(ws.id, user.id, { name: b.name, template: b.template, copyFrom: b.copyFrom, description: b.description }) }, { status: 201 });
      case "updateRole":
        return Response.json({ role: await updateRole(ws.id, user.id, String(b.roleId), { name: b.name, description: b.description, set: b.set, limits: b.limits, scopes: b.scopes }) });
      case "resetRole":
        await resetRole(ws.id, user.id, String(b.roleId));
        return Response.json({ ok: true });
      case "deleteRole":
        await deleteRole(ws.id, user.id, String(b.roleId));
        return Response.json({ ok: true });
      case "assign":
        await assignRole(ws.id, user.id, String(b.roleId), b.subjectType === "group" || b.subjectType === "department" ? b.subjectType : "user", String(b.subjectId));
        return Response.json({ ok: true });
      case "unassign":
        await unassignRole(ws.id, user.id, String(b.roleId), b.subjectType === "group" || b.subjectType === "department" ? b.subjectType : "user", String(b.subjectId));
        return Response.json({ ok: true });
      case "override":
        return Response.json({ override: await addOverride(ws.id, user.id, { userId: String(b.userId), key: String(b.key), effect: b.effect, expiresAt: b.expiresAt ?? null, reason: b.reason }) }, { status: 201 });
      case "removeOverride":
        await removeOverride(ws.id, user.id, String(b.id));
        return Response.json({ ok: true });
      case "preview": {
        const jar = await cookies();
        invalidatePerms();
        if (!b.roleId) {
          jar.delete(PREVIEW_COOKIE);
          return Response.json({ ok: true, preview: null });
        }
        if (!(await canManageRoles(user.id, ws.id))) return Response.json({ error: "Previewing roles needs Manage roles and permissions." }, { status: 403 });
        const role = await db.permRole.findFirst({ where: { id: String(b.roleId), workspaceId: ws.id } });
        if (!role) return Response.json({ error: "Role not found." }, { status: 404 });
        jar.set(PREVIEW_COOKIE, role.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 4 });
        return Response.json({ ok: true, preview: { roleId: role.id, name: role.name } });
      }
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
