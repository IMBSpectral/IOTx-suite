import { requireMe } from "@/lib/auth";
import { removeLink } from "@/lib/tasks";
import { route } from "@/lib/http";

/** DELETE a link between two issues */
async function DELETE_(_req: Request, ctx: { params: Promise<{ lid: string }> }) {
  const me = await requireMe("tasks.open");
  return Response.json(await removeLink(me, (await ctx.params).lid));
}

export const DELETE = route(DELETE_);
