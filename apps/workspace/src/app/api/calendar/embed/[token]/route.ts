import { publicCalendar } from "@/lib/cal-more";

/**
 * GET ?from=ISO&to=ISO -> { calendar: { name, description, color, mode, tz }, events } for a public calendar.
 * No sign-in and no cookies: the unguessable link is the key. Free/busy calendars and private events show only "Busy".
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const from = new Date(q.get("from") ?? Date.now() - 7 * 86_400_000);
  const to = new Date(q.get("to") ?? Date.now() + 35 * 86_400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 100 * 86_400_000)
    return Response.json({ error: "from and to must be dates up to 100 days apart" }, { status: 400 });
  const r = await publicCalendar(token, from, to);
  if (!r) return Response.json({ error: "This calendar isn't public." }, { status: 404 });
  return Response.json(r, { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } });
}
