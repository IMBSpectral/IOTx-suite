import { requirePerm } from "@/lib/iotx/permissions";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { audit } from "@/lib/workspace-security";
import {
  deleteWorkspaceSecret,
  listWorkspaceSecrets,
  setWorkspaceSecret,
  WorkspaceSecretError,
} from "@/lib/workspace-secrets";

/** Workspace secrets: every project can use them; a project secret of the same name wins. Admins only. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  await requirePerm(user.id, ws.id, "builder.cloud.secrets");
  return Response.json({ secrets: await listWorkspaceSecrets(ws.id) });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  await requirePerm(user.id, ws.id, "builder.cloud.secrets");
  const body = (await req.json().catch(() => ({}))) as { action?: string; name?: string; value?: string };
  try {
    if (body.action === "delete") {
      await deleteWorkspaceSecret(ws.id, body.name ?? "");
      await audit(ws.id, user.id, "workspace.secret", `Deleted workspace secret ${body.name}`);
      return Response.json({ ok: true });
    }
    await setWorkspaceSecret(ws.id, body.name ?? "", body.value ?? "", user.id);
    await audit(ws.id, user.id, "workspace.secret", `Set workspace secret ${body.name}`);
    return Response.json({ ok: true }, { status: 201 });
  } catch (e) {
    if (e instanceof WorkspaceSecretError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
