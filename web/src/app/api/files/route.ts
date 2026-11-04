import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError } from "@/lib/iotx/permissions";
import * as files from "@/lib/files";

/**
 * Files.
 *   GET ?view=mine|shared|trash&folder=&search=   -> { items, crumbs, access, usage }
 *   GET ?shares=<id>                              -> { shares }       (the owner)
 *   GET ?admin=1                                  -> storage limits and use per person (owners, admins)
 *   POST { action: "folder", name, parentId? } | { action: "rename", id, name } | { action: "move", id, parentId }
 *        { action: "trash" | "restore" | "delete", id } | { action: "emptyTrash" }
 *        { action: "share", id, userId, canEdit? } | { action: "link", id, days } | { action: "unshare", shareId }
 *        { action: "limit", who: "company" | "default" | <userId>, gb: number | null }   (owners, admins)
 * Uploads: POST /api/files/upload (multipart). Downloads: GET /api/files/<id>[?inline=1].
 */
const fail = (e: unknown) => {
  if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
};

async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  try {
    if (q.get("admin")) return Response.json(await files.storageAdmin(user.id, ws.id));
    if (q.get("shares")) return Response.json({ shares: await files.sharesOf(user.id, ws.id, q.get("shares")!) });
    const [list, usage] = await Promise.all([
      files.listFiles(user.id, ws.id, { view: q.get("view") ?? "mine", folder: q.get("folder"), search: q.get("search") ?? undefined }),
      files.usage(user.id, ws.id),
    ]);
    return Response.json({ ...list, usage });
  } catch (e) {
    return fail(e);
  }
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  try {
    switch (b.action) {
      case "folder":
        return Response.json({ item: await files.createFolder(user.id, ws.id, b.name, typeof b.parentId === "string" ? b.parentId : null) }, { status: 201 });
      case "rename":
        await files.renameItem(user.id, ws.id, id, b.name);
        break;
      case "move":
        await files.moveItem(user.id, ws.id, id, typeof b.parentId === "string" && b.parentId ? b.parentId : null);
        break;
      case "trash":
        await files.trashItem(user.id, ws.id, id);
        break;
      case "restore":
        await files.restoreItem(user.id, ws.id, id);
        break;
      case "delete":
        await files.deleteForever(user.id, ws.id, id);
        break;
      case "emptyTrash":
        return Response.json({ deleted: await files.emptyTrash(user.id, ws.id) });
      case "share":
        await files.shareWith(user.id, ws.id, id, b);
        break;
      case "link": {
        const s = await files.shareLink(user.id, ws.id, id, Number(b.days) || 7);
        return Response.json({ token: s.token, expiresAt: s.expiresAt });
      }
      case "unshare":
        await files.unshare(user.id, ws.id, String(b.shareId ?? ""));
        break;
      case "limit":
        await files.setLimit(user.id, ws.id, String(b.who ?? ""), b.gb === null || b.gb === "" ? null : Number(b.gb));
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
