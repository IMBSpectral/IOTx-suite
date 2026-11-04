import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";

type Ctx = { params: Promise<{ id: string }> };

/** The project's chats: the main chat plus any extra ones, newest activity first. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  const chats = await db.projectChat.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
  const stats = await db.message.groupBy({ by: ["chatId"], where: { projectId: id }, _count: { _all: true }, _max: { createdAt: true } });
  const of = (chatId: string | null) => stats.find((s) => s.chatId === chatId);
  const people = await db.user.findMany({ where: { id: { in: chats.map((c) => c.createdById).filter(Boolean) as string[] } }, select: { id: true, name: true, email: true } });
  const who = (uid: string | null) => people.find((p) => p.id === uid);
  return Response.json({
    chats: [
      { id: null, title: "Main chat", messages: of(null)?._count._all ?? 0, lastAt: of(null)?._max.createdAt ?? null, mine: true, by: null },
      ...chats.map((c) => ({
        id: c.id,
        title: c.title,
        messages: of(c.id)?._count._all ?? 0,
        lastAt: of(c.id)?._max.createdAt ?? c.createdAt,
        mine: c.createdById === user.id,
        by: who(c.createdById)?.name ?? who(c.createdById)?.email ?? null,
      })),
    ],
  });
}

/** Start a new chat. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const { title } = (await req.json().catch(() => ({}))) as { title?: string };
  const count = await db.projectChat.count({ where: { projectId: id } });
  if (count >= 50) return Response.json({ error: "A project can have 50 chats. Delete one first." }, { status: 400 });
  const chat = await db.projectChat.create({ data: { projectId: id, title: title?.trim().slice(0, 80) || `Chat ${count + 2}`, createdById: user.id } });
  return Response.json({ chat }, { status: 201 });
}

/** Rename a chat. */
async function PATCH_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const { chatId, title } = (await req.json().catch(() => ({}))) as { chatId?: string; title?: string };
  const name = title?.trim().slice(0, 80);
  if (!name) return Response.json({ error: "Give the chat a name." }, { status: 400 });
  const { count } = await db.projectChat.updateMany({ where: { id: chatId ?? "", projectId: id }, data: { title: name } });
  if (!count) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}

/** Delete a chat and its messages (the code changes it made stay in history). */
async function DELETE_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const chatId = new URL(req.url).searchParams.get("chatId") ?? "";
  const chat = await db.projectChat.findFirst({ where: { id: chatId, projectId: id } });
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  if (await db.build.count({ where: { projectId: id, status: { in: ["QUEUED", "RUNNING"] }, message: { chatId } } })) {
    return Response.json({ error: "Wait for this chat's turns to finish before deleting it." }, { status: 409 });
  }
  await db.$transaction([db.message.deleteMany({ where: { projectId: id, chatId } }), db.projectChat.delete({ where: { id: chatId } })]);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
