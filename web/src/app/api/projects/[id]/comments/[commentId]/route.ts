import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { REACTIONS } from "@/lib/comments";

type Ctx = { params: Promise<{ id: string; commentId: string }> };

async function load(req: Request, { params }: Ctx) {
  const { id, commentId } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  const comment = await db.comment.findUnique({ where: { id: commentId } });
  if (!comment || comment.projectId !== id) throw new Response("Not found", { status: 404 });
  return { user, project, comment };
}

/** Edit your own comment, resolve/unresolve a thread, or toggle a reaction. */
async function PATCH_(req: Request, ctx: Ctx) {
  const { user, project, comment } = await load(req, ctx);
  const body = (await req.json()) as { body?: string; resolved?: boolean; react?: string };

  if (typeof body.body === "string") {
    if (comment.authorId !== user.id) return Response.json({ error: "You can only edit your own comments." }, { status: 403 });
    const text = body.body.trim().slice(0, 4000);
    if (!text) return Response.json({ error: "A comment can't be empty." }, { status: 400 });
    await db.comment.update({ where: { id: comment.id }, data: { body: text, editedAt: new Date() } });
  }
  if (typeof body.resolved === "boolean") {
    if (comment.parentId) return Response.json({ error: "Resolve the thread, not a reply." }, { status: 400 });
    if (project.access === "view" && comment.authorId !== user.id) {
      return Response.json({ error: "Only editors and the author can resolve this." }, { status: 403 });
    }
    await db.comment.update({
      where: { id: comment.id },
      data: body.resolved ? { resolvedAt: new Date(), resolvedById: user.id } : { resolvedAt: null, resolvedById: null },
    });
  }
  if (body.react) {
    if (!(REACTIONS as readonly string[]).includes(body.react)) return Response.json({ error: "Unknown reaction" }, { status: 400 });
    const r = (comment.reactions as Record<string, string[]> | null) ?? {};
    const who = new Set(r[body.react] ?? []);
    if (who.has(user.id)) who.delete(user.id);
    else who.add(user.id);
    await db.comment.update({ where: { id: comment.id }, data: { reactions: { ...r, [body.react]: [...who] } } });
  }
  return Response.json({ ok: true });
}

/** Delete your own comment (admins can delete any). A thread takes its replies with it. */
async function DELETE_(req: Request, ctx: Ctx) {
  const { user, project, comment } = await load(req, ctx);
  if (comment.authorId !== user.id && project.access !== "admin") {
    return Response.json({ error: "You can only delete your own comments." }, { status: 403 });
  }
  await db.comment.deleteMany({ where: { OR: [{ id: comment.id }, { parentId: comment.id }] } });
  return Response.json({ ok: true });
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
