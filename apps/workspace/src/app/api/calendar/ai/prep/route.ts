import { requireMe } from "@/lib/auth";
import { prep } from "@/lib/cal-ai";
import { bad, body, route } from "@/lib/http";

/** POST { eventId, occ? } -> guests, related tasks, related emails (from the suite's Mail, only the person's own mailboxes) and a 3-bullet briefing. */
async function POST_(req: Request) {
  const me = await requireMe("calendar.open");
  const b = await body<{ eventId?: string; occ?: string | null }>(req);
  if (!b.eventId) bad("eventId is required");
  return Response.json(await prep(me, b.eventId, b.occ ?? null));
}

export const POST = route(POST_);
