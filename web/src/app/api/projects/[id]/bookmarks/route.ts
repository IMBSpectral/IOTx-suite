import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { headSha } from "@/lib/repo";
import { route } from "@/lib/route";

type Ctx = { params: Promise<{ id: string }> };

/** Named points in history ("Bookmark in history"). */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const bookmarks = await db.bookmark.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
  });
  return Response.json({ bookmarks });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const { sha, name } = (await req.json().catch(() => ({}))) as { sha?: string; name?: string };
  const target = sha && /^[0-9a-f]{40}$/.test(sha) ? sha : await headSha(id);
  const bookmark = await db.bookmark.create({
    data: {
      projectId: id,
      sha: target,
      name: name?.trim().slice(0, 80) || "Bookmark",
      createdById: user.id,
    },
  });
  return Response.json({ bookmark });
}

async function PATCH_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const { bookmarkId, name } = (await req.json().catch(() => ({}))) as {
    bookmarkId?: string;
    name?: string;
  };
  if (!bookmarkId || !name?.trim()) return Response.json({ error: "Name required" }, { status: 400 });
  const res = await db.bookmark.updateMany({
    where: { id: bookmarkId, projectId: id },
    data: { name: name.trim().slice(0, 80) },
  });
  return Response.json({ ok: res.count > 0 });
}

async function DELETE_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const bookmarkId = new URL(req.url).searchParams.get("bookmarkId");
  if (!bookmarkId) return Response.json({ error: "bookmarkId required" }, { status: 400 });
  await db.bookmark.deleteMany({ where: { id: bookmarkId, projectId: id } });
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
