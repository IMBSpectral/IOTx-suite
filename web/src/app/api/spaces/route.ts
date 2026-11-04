import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import * as spaces from "@/lib/spaces";

/**
 * Dashboards and folders in the sidebar.
 *   GET                 -> { spaces, can }      the sidebar
 *   GET ?id=            -> one dashboard/folder, opened
 *   GET ?access=<id>    -> its roles and people
 *   GET ?role=<roleId>  -> Admin → Roles: every one and whether the role sees it
 *   GET ?apps=1         -> apps that can be added
 *   POST { action, … }  -> create | rename | delete | move | addItem | removeItem | setAccess
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  return reply(async () => {
    const v = await spaces.viewer(user.id, ws.id);
    if (q.get("id")) return spaces.open(v, q.get("id")!);
    if (q.get("access")) return spaces.access(v, q.get("access")!);
    if (q.get("role")) return { spaces: await spaces.forRole(v, q.get("role")!) };
    if (q.get("apps")) return { apps: await spaces.pickableApps(v) };
    return spaces.sidebar(v);
  });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  return reply(async () => {
    const v = await spaces.viewer(user.id, ws.id);
    switch (b.action) {
      case "create": {
        const kind = b.kind === "dashboard" ? "dashboard" : "folder";
        return { space: await spaces.create(v, kind, str("name"), str("parentId") || null) };
      }
      case "rename":
        return spaces.rename(v, str("id"), str("name"));
      case "delete":
        return spaces.remove(v, str("id"));
      case "move":
        return spaces.move(v, str("id"), str("parentId") || null);
      case "addItem":
        return { item: await spaces.addItem(v, str("spaceId"), { kind: b.kind === "link" ? "link" : "project", ref: str("ref"), title: str("title") }) };
      case "removeItem":
        return spaces.removeItem(v, str("itemId"));
      case "setAccess":
        return spaces.setAccess(v, str("id"), b.subjectType === "user" ? "user" : "role", str("subjectId"), b.on === true);
      default:
        throw new PermissionError("Unknown action.");
    }
  });
}

async function reply(fn: () => Promise<unknown>) {
  try {
    return Response.json((await fn()) ?? { ok: true });
  } catch (e) {
    if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
