import { requireMe } from "@/lib/auth";
import { saveMessage } from "@/lib/chat";
import { body, route } from "@/lib/http";

/** POST { saved?: false, remindAt?: ISO | null, done?: boolean } -> save for later / remind me / mark done */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  return Response.json(await saveMessage(me, (await ctx.params).id, await body(req)));
}

export const POST = route(POST_);
