import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { cleanShot, listThreads, notifyComment } from "@/lib/comments";

type Ctx = { params: Promise<{ id: string }> };

async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const shotOf = new URL(req.url).searchParams.get("shot");
  if (shotOf) {
    const c = await db.comment.findFirst({
      where: { id: shotOf, projectId: id },
      select: { elementShot: true },
    });
    const m = c?.elementShot
      ? /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(c.elementShot)
      : null;
    if (!m) return new Response("Not found", { status: 404 });
    return new Response(Buffer.from(m[2], "base64"), {
      headers: {
        "content-type": m[1],
        "cache-control": "private, max-age=86400",
      },
    });
  }
  const threads = await listThreads(id, user.id);
  return Response.json({
    threads,
    unread: threads.filter((t) => t.unread && !t.resolvedAt).length,
  });
}

/** New thread (pinned to an element) or a reply. Anyone who can view can comment. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  const body = (await req.json()) as {
    body?: string;
    parentId?: string;
    locator?: string;
    selector?: string;
    elementText?: string;
    elementShot?: string;
    action?: "read";
  };

  if (body.action === "read") {
    await db.projectVisit.upsert({
      where: { userId_projectId: { userId: user.id, projectId: id } },
      create: { userId: user.id, projectId: id, commentsReadAt: new Date() },
      update: { commentsReadAt: new Date() },
    });
    return Response.json({ ok: true });
  }

  const text = body.body?.trim().slice(0, 4000);
  if (!text)
    return Response.json({ error: "Write something first." }, { status: 400 });
  if (body.parentId) {
    const parent = await db.comment.findUnique({
      where: { id: body.parentId },
    });
    if (!parent || parent.projectId !== id || parent.parentId) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }
  }
  const c = await db.comment.create({
    data: {
      projectId: id,
      parentId: body.parentId ?? null,
      authorId: user.id,
      body: text,
      locator: body.parentId ? null : body.locator?.slice(0, 1000),
      selector: body.parentId ? null : body.selector?.slice(0, 300),
      elementText: body.parentId ? null : body.elementText?.slice(0, 200),
      elementShot: body.parentId ? null : cleanShot(body.elementShot),
    },
  });
  await notifyComment({
    project,
    authorId: user.id,
    authorName: user.name ?? user.email ?? "Someone",
    body: text,
    threadId: body.parentId ?? c.id,
  });
  return Response.json({ id: c.id }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
