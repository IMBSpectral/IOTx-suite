import { respond } from "@/lib/chat-apps";
import { body, route } from "@/lib/http";

/** A slash command's response_url (30 minutes): POST { text, response_type: "in_channel" | "ephemeral" }. */
async function POST_(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return Response.json(await respond((await ctx.params).token, await body(req)));
}

export const POST = route(POST_);
