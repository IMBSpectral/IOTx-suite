import { requireMe } from "@/lib/auth";
import { searchEvents } from "@/lib/cal-plus";
import { route } from "@/lib/http";

/** GET ?q= -> { results } events by title, description, location or guest, nearest first */
async function GET_(req: Request) {
  const me = await requireMe("calendar.open");
  return Response.json({ results: await searchEvents(me, new URL(req.url).searchParams.get("q") ?? "") });
}

export const GET = route(GET_);
