import { requireMe } from "@/lib/auth";
import { toggleReaction } from "@/lib/chat";
import { body, route } from "@/lib/http";

/** POST { emoji } -> toggles my reaction; { message } */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  const b = await body<{ emoji?: string }>(req);
  return Response.json({ message: await toggleReaction(me, (await ctx.params).id, String(b.emoji ?? "")) });
}

export const POST = route(POST_);
