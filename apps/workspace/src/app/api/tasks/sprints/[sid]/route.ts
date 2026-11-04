import { requireMe } from "@/lib/auth";
import { deleteSprint, updateSprint } from "@/lib/tasks-plan";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ sid: string }> };

/** PATCH { name?, goal?, startAt?, endAt?, action?: "start" | "complete", moveTo?: sprint id | "backlog" } · DELETE (not the running one) */
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ sprint: await updateSprint(me, (await ctx.params).sid, await body(req)) });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteSprint(me, (await ctx.params).sid));
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
