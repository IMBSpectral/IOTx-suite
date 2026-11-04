import { requireMe } from "@/lib/auth";
import { deleteHook } from "@/lib/chat";
import { route } from "@/lib/http";

/** DELETE a channel's incoming webhook */
async function DELETE_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  return Response.json(await deleteHook(me, (await ctx.params).id));
}

export const DELETE = route(DELETE_);
