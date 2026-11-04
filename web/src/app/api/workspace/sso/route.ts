import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { audit } from "@/lib/workspace-security";
import { checkSso, disableSso, saveSso, SsoError, ssoSettings } from "@/lib/sso";

/** SSO setup for the workspace (owners and admins). */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  return Response.json(await ssoSettings(ws.id));
}

/** save {domain, issuer, clientId, clientSecret?, scopes?, groupsClaim?, allowedGroups?, groupRoles?} · check · disable */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (b.action === "check") return Response.json({ check: await checkSso(ws.id) });
    if (b.action === "disable") {
      await disableSso(ws.id);
      await audit(ws.id, user.id, "workspace.settings", "Turned off SSO");
      return Response.json({ ok: true });
    }
    const check = await saveSso(ws.id, b);
    await audit(ws.id, user.id, "workspace.settings", `SSO (${b.protocol === "saml" ? "SAML" : "OIDC"}) set up with ${String(b.protocol === "saml" ? b.entityId : b.issuer)} for @${String(b.domain)}`);
    return Response.json({ check });
  } catch (e) {
    if (e instanceof SsoError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
