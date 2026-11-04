import { requireMe } from "@/lib/auth";
import { deleteMessage, editMessage, getMessage } from "@/lib/chat";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { message } (for deep links); PATCH { body? | pinned? }; DELETE (own, or any with teamchat.admin) */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json({ message: await getMessage(me, (await ctx.params).id) });
}
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json({ message: await editMessage(me, (await ctx.params).id, await body(req)) });
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json(await deleteMessage(me, (await ctx.params).id));
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
