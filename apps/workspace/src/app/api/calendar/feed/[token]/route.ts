import { feed } from "@/lib/cal-plus";

/** GET -> a calendar's secret iCal feed (no sign-in; the link is the key). Add it to Google, Outlook or Apple Calendar. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const token = (await ctx.params).token.replace(/\.ics$/i, "");
  const ics = /^[\w-]{20,60}$/.test(token) ? await feed(token) : null;
  if (!ics) return new Response("Not found", { status: 404 });
  return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300" } });
}
