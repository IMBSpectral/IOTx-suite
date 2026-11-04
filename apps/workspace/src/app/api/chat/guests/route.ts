import { requireMe } from "@/lib/auth";
import { inviteGuest, listGuests } from "@/lib/chat-guests";
import { body, route } from "@/lib/http";

/**
 * Chat guests (teamchat.admin):
 * GET  -> { guests }
 * POST { email, name?, channelIds, expiresAt?, note? } -> the guest (an invitation email goes out)
 */
async function GET_() {
  const me = await requireMe("teamchat.open");
  return Response.json({ guests: await listGuests(me) });
}
async function POST_(req: Request) {
  const me = await requireMe("teamchat.open");
  return Response.json({ guest: await inviteGuest(me, await body(req)) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
