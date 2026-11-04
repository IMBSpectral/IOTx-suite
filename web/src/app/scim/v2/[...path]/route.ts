import {
  createGroup,
  createUser,
  deleteGroup,
  deleteUser,
  getUser,
  listGroups,
  listUsers,
  patchGroup,
  patchUser,
  replaceUser,
  ScimError,
  workspaceForToken,
} from "@/lib/scim";

/** SCIM 2.0 for identity providers: /scim/v2/Users, /Groups, /ServiceProviderConfig. Bearer: the workspace's SCIM token. */
type Ctx = { params: Promise<{ path: string[] }> };
const SCIM = { "content-type": "application/scim+json" };
const out = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: SCIM });
const error = (detail: string, status: number) => out({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail, status: String(status) }, status);

async function handle(req: Request, { params }: Ctx) {
  const ws = await workspaceForToken(req.headers.get("authorization"));
  if (!ws) return error("A valid SCIM token is required.", 401);
  const [resource, id] = (await params).path;
  const q = new URL(req.url).searchParams;
  const body = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const ops = (body.Operations ?? []) as { op?: string; path?: string; value?: unknown }[];
  try {
    if (resource === "ServiceProviderConfig") {
      return out({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "The workspace's SCIM token" }],
      });
    }
    if (resource === "Users") {
      if (!id && req.method === "GET") return out(await listUsers(ws, q.get("filter"), Number(q.get("startIndex") ?? 1) || 1, Number(q.get("count") ?? 100) || 100));
      if (!id && req.method === "POST") return out(await createUser(ws, body), 201);
      if (id && req.method === "GET") return out(await getUser(ws, id));
      if (id && req.method === "PUT") return out(await replaceUser(ws, id, body));
      if (id && req.method === "PATCH") return out(await patchUser(ws, id, ops));
      if (id && req.method === "DELETE") {
        await deleteUser(ws, id);
        return out(null, 204);
      }
    }
    if (resource === "Groups") {
      if (!id && req.method === "GET") return out(await listGroups(ws, q.get("filter")));
      if (!id && req.method === "POST") return out(await createGroup(ws, body), 201);
      if (id && req.method === "PATCH") return out(await patchGroup(ws, id, ops));
      if (id && req.method === "DELETE") {
        await deleteGroup(ws, id);
        return out(null, 204);
      }
    }
    return error("Not found", 404);
  } catch (e) {
    if (e instanceof ScimError) return error(e.message, e.status);
    throw e;
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
