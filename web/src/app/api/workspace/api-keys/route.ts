import { requirePerm } from "@/lib/iotx/permissions";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { audit } from "@/lib/workspace-security";
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey, SCOPES, setKeyLimit } from "@/lib/api-keys";

const ORIGIN = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";

/** Workspace API keys and the MCP server address (owners and admins). */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  await requirePerm(user.id, ws.id, "builder.api_keys");
  return Response.json({ keys: await listApiKeys(ws.id), scopes: SCOPES, mcpUrl: `${ORIGIN}/api/mcp` });
}

/** create {name, scopes, monthlyLimit?} → token shown once · revoke {id} · limit {id, monthlyLimit} */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  await requirePerm(user.id, ws.id, "builder.api_keys");
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; name?: string; scopes?: string[]; monthlyLimit?: number | null };
  try {
    switch (b.action) {
      case "create": {
        const k = await createApiKey(ws.id, user.id, b);
        await audit(ws.id, user.id, "workspace.secret", `Created API key ${b.name} (${(b.scopes ?? []).join(", ")})`);
        return Response.json(k, { status: 201 });
      }
      case "revoke":
        await revokeApiKey(ws.id, b.id ?? "");
        await audit(ws.id, user.id, "workspace.secret", `Revoked an API key`);
        return Response.json({ ok: true });
      case "limit":
        await setKeyLimit(ws.id, b.id ?? "", b.monthlyLimit ?? null);
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ApiKeyError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
