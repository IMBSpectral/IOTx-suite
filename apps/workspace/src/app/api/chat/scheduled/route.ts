import { requireMe } from "@/lib/auth";
import { listScheduled } from "@/lib/chat";
import { route } from "@/lib/http";

/** GET -> { scheduled } my messages waiting to be sent */
async function GET_() {
  const me = await requireMe("teamchat.open");
  return Response.json({ scheduled: await listScheduled(me) });
}

export const GET = route(GET_);
