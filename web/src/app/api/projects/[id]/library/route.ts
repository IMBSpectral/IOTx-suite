import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { getCollections, LibraryError, listLibrary, readLibraryItem, updateCollections } from "@/lib/library";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The files library. Without ?key: every item plus the collections. With
 * ?key: that file's bytes (inline for preview, or as a download with
 * &download=1). Files are served sandboxed: an uploaded SVG or HTML can't run
 * script on the editor's origin.
 */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  if (!key) {
    const [items, collections] = await Promise.all([listLibrary(id), getCollections(id)]);
    return Response.json({ items, collections });
  }
  const file = await readLibraryItem(id, key);
  if (!file) return Response.json({ error: "Not found" }, { status: 404 });
  const download = url.searchParams.get("download") === "1";
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.type,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${file.name.replace(/"/g, "")}"`,
      "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=60",
    },
  });
}

/** Collection changes. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const body = (await req.json().catch(() => ({}))) as {
    action?: "create" | "rename" | "delete" | "add" | "remove";
    id?: string;
    name?: string;
    keys?: string[];
  };
  try {
    switch (body.action) {
      case "create":
        return Response.json({ collections: await updateCollections(id, { action: "create", name: body.name ?? "" }) });
      case "rename":
        return Response.json({ collections: await updateCollections(id, { action: "rename", id: body.id ?? "", name: body.name ?? "" }) });
      case "delete":
        return Response.json({ collections: await updateCollections(id, { action: "delete", id: body.id ?? "" }) });
      case "add":
      case "remove":
        return Response.json({
          collections: await updateCollections(id, { action: body.action, id: body.id ?? "", keys: (body.keys ?? []).slice(0, 500) }),
        });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof LibraryError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
