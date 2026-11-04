import { requireMe } from "@/lib/auth";
import { deleteColumn } from "@/lib/tasks-board";
import { body, route } from "@/lib/http";

/** DELETE-style: POST { statusId, moveTo } removes a column after moving its issues (adding, renaming, moving and limits go through PATCH statuses). */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  const b = await body<{ statusId?: string; moveTo?: string }>(req);
  return Response.json(await deleteColumn(me, (await ctx.params).id, String(b.statusId ?? ""), String(b.moveTo ?? "")));
}

export const POST = route(POST_);
