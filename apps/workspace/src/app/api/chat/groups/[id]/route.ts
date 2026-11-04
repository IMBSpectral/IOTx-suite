import { requireMe } from "@/lib/auth";
import { deleteGroup, saveGroup } from "@/lib/chat";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH { handle?, name?, memberIds? } · DELETE */
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json({ group: await saveGroup(me, (await ctx.params).id, await body(req)) });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json(await deleteGroup(me, (await ctx.params).id));
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
