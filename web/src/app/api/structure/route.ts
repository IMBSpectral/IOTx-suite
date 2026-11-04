import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { effectiveForRequest, PermissionError } from "@/lib/iotx/permissions";
import { db } from "@/lib/db";
import { createDepartment, deleteDepartment, invitePeople, loadStructure, movePeople, reportsOf, updateDepartment, updatePerson, type InviteRow } from "@/lib/structure";

/**
 * People → Company structure.
 *   GET                         -> { departments, people, canEdit, me }   (anyone in the workspace; HR fields only where allowed)
 *   POST { action: "createDept", name, parentId?, headId?, color? }
 *   POST { action: "updateDept", id, name?, parentId?, headId?, color? }
 *   POST { action: "deleteDept", id }                   people and sub-departments move up a level
 *   POST { action: "updatePerson", userId, departmentId?, managerId?, title?, phone?, employeeCode?, location?, joinedOn? }
 *   POST { action: "move", userIds, departmentId }       bulk "change department"
 *   POST { action: "invite", rows: [{ email, name?, title?, department?, manager?, role?, … }] }   add and place people (owners and admins)
 *   GET ?team=1                 -> { team: [{ userId, direct, tasks: { open, overdue, dueThisWeek, top } | null }] }   my reports' open work
 * Changes need an owner, admin, or "Manage roles and permissions".
 */
const WORKSPACE_INTERNAL = (process.env.WORKSPACE_INTERNAL_URL ?? "http://127.0.0.1:3100/workspace").replace(/\/$/, "");

async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  if (new URL(req.url).searchParams.get("team")) return Response.json(await team(user.id, ws.id));
  return Response.json(await loadStructure(user.id, ws.id));
}

/** Everyone who reports to me (directly or further down), with their open tasks as far as my Tasks access goes. */
async function team(userId: string, workspaceId: string) {
  const profiles = await db.employeeProfile.findMany({ where: { workspaceId }, select: { userId: true, managerId: true } });
  const ids = [...reportsOf(profiles, userId)];
  const direct = new Set(profiles.filter((p) => p.managerId === userId).map((p) => p.userId));
  let tasks: Record<string, unknown> | null = null;
  let note: string | null = null;
  const perms = await effectiveForRequest(userId, workspaceId);
  if (ids.length && perms?.keys.includes("tasks.open")) {
    const owner = (await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } }))?.role === "OWNER";
    const r = await fetch(`${WORKSPACE_INTERNAL}/api/internal/ai`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-iotx-key": process.env.IOTX_SERVICE_KEY ?? "" },
      body: JSON.stringify({ userId, ws: workspaceId, owner, perms: perms.keys, tool: "team_tasks", input: { userIds: ids } }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (d?.result) tasks = d.result;
    else note = d?.error ?? "Tasks didn't answer.";
  } else if (ids.length) note = "Your role doesn't include Tasks, so team tasks aren't shown.";
  return { team: ids.map((id) => ({ userId: id, direct: direct.has(id), tasks: (tasks?.[id] as unknown) ?? null })), note };
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  try {
    switch (b.action) {
      case "createDept":
        return Response.json({ department: await createDepartment(user.id, ws.id, b) }, { status: 201 });
      case "updateDept":
        return Response.json({ department: await updateDepartment(user.id, ws.id, id, b) });
      case "deleteDept":
        await deleteDepartment(user.id, ws.id, id);
        return Response.json({ ok: true });
      case "updatePerson":
        return Response.json({ profile: await updatePerson(user.id, ws.id, String(b.userId ?? ""), b) });
      case "invite": {
        const rows = (Array.isArray(b.rows) ? b.rows : []).filter((r): r is InviteRow => !!r && typeof r === "object");
        if (!rows.length) return Response.json({ error: "Add at least one person." }, { status: 400 });
        return Response.json({ results: await invitePeople(user.id, ws.id, rows) });
      }
      case "move": {
        const ids = Array.isArray(b.userIds) ? b.userIds.map(String) : [];
        const moved = await movePeople(user.id, ws.id, ids, typeof b.departmentId === "string" && b.departmentId ? b.departmentId : null);
        return Response.json({ moved });
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
