import { db } from "@/lib/db";
import { KbError, removeSource, syncSource } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

type Ctx = { params: Promise<{ id: string }> };

/** POST -> sync the folder now { added, updated, archived, failed } · DELETE ?keep=1 (keep its articles) */
async function POST_(_req: Request, { params }: Ctx) {
  const v = await kbViewer("read.publish");
  const s = await db.kbSource.findUnique({ where: { id: (await params).id } });
  if (!s || s.workspaceId !== v.workspaceId) throw new KbError("Folder not found", 404);
  return Response.json(await syncSource(s.id));
}
async function DELETE_(req: Request, { params }: Ctx) {
  const v = await kbViewer("read.publish");
  return Response.json(await removeSource(v, (await params).id, new URL(req.url).searchParams.get("keep") === "1"));
}

export const POST = kbRoute(POST_);
export const DELETE = kbRoute(DELETE_);
