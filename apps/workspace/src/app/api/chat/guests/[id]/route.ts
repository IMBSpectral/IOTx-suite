import { requireMe } from "@/lib/auth";
import { updateGuest } from "@/lib/chat-guests";
import { body, route } from "@/lib/http";

/** PATCH { channelIds?, expiresAt?, name?, deactivated?, resend? } -> the guest (teamchat.admin). */
async function PATCH_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  return Response.json({ guest: await updateGuest(me, (await ctx.params).id, await body(req)) });
}

export const PATCH = route(PATCH_);
