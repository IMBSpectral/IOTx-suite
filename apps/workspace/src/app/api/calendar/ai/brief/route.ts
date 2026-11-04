import { requireMe } from "@/lib/auth";
import { brief, localDate } from "@/lib/cal-smart";
import { briefHeadline } from "@/lib/cal-ai";
import { route } from "@/lib/http";

/**
 * GET ?date=YYYY-MM-DD -> the daily brief: agenda, conflicts and overload,
 * free gaps, focus suggestions, tasks due, prep notes per meeting. No AI, fast.
 * POST ?date= -> { headline } a one-sentence summary written by the AI.
 */
async function GET_(req: Request) {
  const me = await requireMe("calendar.open");
  const q = new URL(req.url).searchParams.get("date");
  const date = q && /^\d{4}-\d\d-\d\d$/.test(q) ? q : localDate(Date.now(), me.tz || "UTC");
  return Response.json(await brief(me, date));
}

async function POST_(req: Request) {
  const me = await requireMe("calendar.open");
  const q = new URL(req.url).searchParams.get("date");
  const date = q && /^\d{4}-\d\d-\d\d$/.test(q) ? q : localDate(Date.now(), me.tz || "UTC");
  const b = await brief(me, date);
  return Response.json({ headline: await briefHeadline(me, b) });
}

export const GET = route(GET_);
export const POST = route(POST_);
