import { botMe } from "@/lib/chat-apps";
import { deleteMessage, editMessage } from "@/lib/chat";
import { body, route } from "@/lib/http";

/** The bot API: PATCH { text } edits, DELETE deletes one of the bot's own messages. */
async function PATCH_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { me } = await botMe(req);
  const b = await body<{ text?: string }>(req);
  return Response.json({ message: await editMessage(me, (await ctx.params).id, { body: String(b.text ?? "") }) });
}
async function DELETE_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { me } = await botMe(req);
  return Response.json(await deleteMessage(me, (await ctx.params).id));
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
