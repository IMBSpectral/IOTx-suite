import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import {
  addAdmin,
  createOrg,
  createOrgWorkspace,
  isOrgAdmin,
  OrgError,
  orgAuditLog,
  orgOf,
  orgOverview,
  removeAdmin,
  removeOrgWorkspace,
  setStandards,
  updateOrg,
} from "@/lib/orgs";

/**
 * The current workspace's organization. Org admins get the overview (and
 * ?view=audit for the org audit log); a workspace owner without an org can
 * create one.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const org = await orgOf(ws.id);
  if (!org) return Response.json({ org: null, canCreate: (await requireRole(user.id, ws.id, ["OWNER"]).then(() => true, () => false)) });
  if (!(await isOrgAdmin(org.id, user.id))) return Response.json({ org: { id: org.id, name: org.name }, admin: false });
  try {
    if (new URL(req.url).searchParams.get("view") === "audit") return Response.json({ events: await orgAuditLog(org.id, user.id) });
    return Response.json({ org: await orgOverview(org.id, user.id), admin: true });
  } catch (e) {
    if (e instanceof OrgError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  try {
    if (b.action === "create") {
      await requireRole(user.id, ws.id, ["OWNER"]);
      const org = await createOrg(ws.id, user.id, str("name"));
      return Response.json({ id: org.id }, { status: 201 });
    }
    const org = await orgOf(ws.id);
    if (!org) return Response.json({ error: "This workspace isn't in an organization." }, { status: 404 });
    switch (b.action) {
      case "update":
        await updateOrg(org.id, user.id, { name: typeof b.name === "string" ? b.name : undefined, avatar: typeof b.avatar === "string" ? b.avatar : undefined });
        break;
      case "addAdmin":
        await addAdmin(org.id, user.id, str("email"));
        break;
      case "removeAdmin":
        await removeAdmin(org.id, user.id, str("userId"));
        break;
      case "createWorkspace": {
        const w = await createOrgWorkspace(org.id, user.id, str("name"));
        return Response.json({ id: w.id }, { status: 201 });
      }
      case "removeWorkspace":
        await removeOrgWorkspace(org.id, user.id, str("workspaceId"));
        break;
      case "standards":
        await setStandards(org.id, user.id, (b.settings ?? {}) as Record<string, unknown>, Array.isArray(b.enforced) ? (b.enforced as string[]) : []);
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof OrgError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
