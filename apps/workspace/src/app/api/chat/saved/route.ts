import { requireMe } from "@/lib/auth";
import { listSaved } from "@/lib/chat";
import { route } from "@/lib/http";

/** GET -> { items } my saved messages, with reminders */
async function GET_() {
  const me = await requireMe("teamchat.open");
  return Response.json({ items: await listSaved(me) });
}

export const GET = route(GET_);
