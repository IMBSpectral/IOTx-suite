import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { audit } from "@/lib/workspace-security";
import { disableScim, rotateToken, ScimError, scimSettings, updateScimSettings } from "@/lib/scim";

/** SCIM provisioning settings (owners and admins). */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  return Response.json(await scimSettings(ws.id));
}

/** rotate → new token (shown once) · disable · settings {defaultRole?, groupRoles?, welcomeEmail?} */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const b = (await req.json().catch(() => ({}))) as { action?: string; defaultRole?: string; groupRoles?: Record<string, string>; welcomeEmail?: boolean };
  try {
    if (b.action === "rotate") {
      const token = await rotateToken(ws.id);
      await audit(ws.id, user.id, "workspace.settings", "Created a new SCIM token");
      return Response.json({ token });
    }
    if (b.action === "disable") {
      await disableScim(ws.id);
      await audit(ws.id, user.id, "workspace.settings", "Turned off SCIM provisioning");
      return Response.json({ ok: true });
    }
    if (b.action === "settings") {
      await updateScimSettings(ws.id, b);
      return Response.json(await scimSettings(ws.id));
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof ScimError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
