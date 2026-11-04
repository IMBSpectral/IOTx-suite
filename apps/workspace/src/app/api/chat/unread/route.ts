import { requireMe } from "@/lib/auth";
import { unreadTotals } from "@/lib/chat";
import { route } from "@/lib/http";

/** GET -> { total, channels: { id: count } } */
async function GET_() {
  const me = await requireMe("teamchat.open");
  return Response.json(await unreadTotals(me));
}

export const GET = route(GET_);
