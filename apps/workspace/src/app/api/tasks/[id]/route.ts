import { requireMe } from "@/lib/auth";
import { deleteTask, taskDetail, updateTask, type TaskInput } from "@/lib/tasks";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET (id or key like ENG-12) -> the full issue · PATCH TaskInput (projectId moves it) · DELETE (needs tasks.delete) */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await taskDetail(me, (await ctx.params).id));
}
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ task: await updateTask(me, (await ctx.params).id, await body<TaskInput>(req)) });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteTask(me, (await ctx.params).id));
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
