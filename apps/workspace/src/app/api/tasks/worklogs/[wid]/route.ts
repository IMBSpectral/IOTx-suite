import { requireMe } from "@/lib/auth";
import { deleteWorklog } from "@/lib/tasks";
import { route } from "@/lib/http";

/** DELETE your own logged time */
async function DELETE_(_req: Request, ctx: { params: Promise<{ wid: string }> }) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteWorklog(me, (await ctx.params).wid));
}

export const DELETE = route(DELETE_);
