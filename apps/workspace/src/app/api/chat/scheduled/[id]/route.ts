import { requireMe } from "@/lib/auth";
import { updateScheduled } from "@/lib/chat";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH { body?, sendAt?, sendNow? } · DELETE cancels */
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json(await updateScheduled(me, (await ctx.params).id, await body(req)));
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json(await updateScheduled(me, (await ctx.params).id, { cancel: true }));
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
