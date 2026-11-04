import { requireMe } from "@/lib/auth";
import { deleteBot, updateBot } from "@/lib/chat-apps";
import { body, route } from "@/lib/http";

/** PATCH { name?, description?, eventsUrl?, commands?, disabled?, rotate? } -> { bot, token? }; DELETE removes it (teamchat.admin). */
async function PATCH_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  return Response.json(await updateBot(me, (await ctx.params).id, await body(req)));
}
async function DELETE_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  return Response.json(await deleteBot(me, (await ctx.params).id));
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
