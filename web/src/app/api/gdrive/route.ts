import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PermissionError, requirePerm } from "@/lib/iotx/permissions";
import { connectionOf, driveContent, driveCrumbs, driveList, fileMeta, GoogleError, googleConfigured } from "@/lib/google";
import { uploadFile } from "@/lib/files";

/**
 * Google Drive: the signed-in person's own Drive, through their Google connection.
 *   GET ?view=status                                         -> { configured, connection }
 *   GET ?view=mine|shared|recent|starred&folder=&q=&page=    -> { files, nextPageToken, crumbs }
 *   GET ?item=<id>                                           -> { item }   (one file, to open it from a link)
 *   POST { action: "toFiles", id, parentId? }                -> copies the file into Files (company storage)
 * Downloads: GET /api/gdrive/<id>.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  if (q.get("view") === "status") return Response.json({ configured: googleConfigured(), connection: await connectionOf(user.id) });
  await requirePerm(user.id, ws.id, "gdrive.open");
  try {
    if (q.get("item")) return Response.json({ item: await fileMeta(user.id, q.get("item")!) });
    const folder = q.get("folder");
    const [list, crumbs] = await Promise.all([
      driveList(user.id, { view: q.get("view") ?? "mine", folder, search: q.get("q") ?? undefined, pageToken: q.get("page") ?? undefined }),
      folder ? driveCrumbs(user.id, folder) : Promise.resolve([]),
    ]);
    return Response.json({ ...list, crumbs });
  } catch (e) {
    if (e instanceof GoogleError) return Response.json({ error: e.message }, { status: e.code && e.code < 500 ? e.code : 502 });
    throw e;
  }
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; parentId?: string | null };
  if (b.action !== "toFiles" || !b.id) return Response.json({ error: "Unknown action" }, { status: 400 });
  await requirePerm(user.id, ws.id, "gdrive.open", "gdrive.copy");
  try {
    const meta = await fileMeta(user.id, b.id);
    const f = await driveContent(user.id, { id: b.id, name: meta.name, mimeType: meta.mimeType, modifiedTime: meta.modifiedTime ?? "", size: meta.size });
    const saved = await uploadFile(user.id, ws.id, new File([new Uint8Array(f.data)], f.name, { type: f.type }), b.parentId ?? null);
    return Response.json({ file: saved });
  } catch (e) {
    if (e instanceof GoogleError) return Response.json({ error: e.message }, { status: e.code && e.code < 500 ? e.code : 502 });
    if (e instanceof PermissionError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
