import { requireMe } from "@/lib/auth";
import { createBot, listBots } from "@/lib/chat-apps";
import { body, route } from "@/lib/http";

/**
 * GET  -> { bots } (everyone; tokens and secrets are never returned)
 * POST { name, description?, eventsUrl?, commands? } -> { bot, token, secret } (teamchat.admin; shown once)
 */
async function GET_() {
  const me = await requireMe("teamchat.open");
  return Response.json({ bots: await listBots(me) });
}
async function POST_(req: Request) {
  const me = await requireMe("teamchat.open");
  return Response.json(await createBot(me, await body(req)), { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
