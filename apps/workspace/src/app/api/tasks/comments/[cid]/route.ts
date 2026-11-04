import { requireMe } from "@/lib/auth";
import { editComment } from "@/lib/tasks";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ cid: string }> };

/** PATCH { body } · DELETE: your own comments (or the workspace owner) */
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ comment: await editComment(me, (await ctx.params).cid, String((await body<{ body?: string }>(req)).body ?? "")) });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await editComment(me, (await ctx.params).cid, null));
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
