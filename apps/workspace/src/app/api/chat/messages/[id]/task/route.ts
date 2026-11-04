import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { INCLUDE, loadMessage, messageDto } from "@/lib/chat";
import { createTask } from "@/lib/tasks";
import { publish } from "@/lib/bus";
import { bad } from "@/lib/http";
import { body, route } from "@/lib/http";

/** POST { projectId, title?, assigneeId?, due? } -> "Make this a task": { task } linked back to the message. */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(["teamchat.open", "tasks.open", "tasks.create"]);
  const { m, ch } = await loadMessage(me, (await ctx.params).id);
  if (m.deletedAt) bad("That message was deleted.");
  const b = await body<{ projectId?: string; title?: string; assigneeId?: string; due?: string }>(req);
  const author = await db.user.findUnique({ where: { id: m.userId } });
  const firstLine = m.body.split("\n")[0].slice(0, 200);
  const task = await createTask(me, {
    projectId: b.projectId,
    title: (b.title ?? "").trim() || firstLine,
    description: `From ${ch.kind === "dm" ? "a direct message" : `#${ch.name}`} — ${author?.name ?? author?.email ?? "someone"}:\n\n${m.body}`,
    assigneeId: b.assigneeId,
    due: b.due,
    messageId: m.id,
  });
  const u = await db.message.update({ where: { id: m.id }, data: { taskId: task.id }, include: INCLUDE });
  publish(`ws:${me.ws}`, { type: "message.update", channelId: ch.id, kind: ch.kind, message: messageDto(u) });
  return Response.json({ task }, { status: 201 });
}

export const POST = route(POST_);
