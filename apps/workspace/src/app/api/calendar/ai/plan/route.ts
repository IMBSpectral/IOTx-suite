import { requireMe } from "@/lib/auth";
import { planDay } from "@/lib/cal-ai";
import { localDate } from "@/lib/cal-smart";
import { body, route } from "@/lib/http";

/** POST { date? } -> tentative focus blocks for my open tasks in today's free time. Nothing is saved: each block is accepted (POST /calendar/ai/apply) or dismissed. */
async function POST_(req: Request) {
  const me = await requireMe(["calendar.open", "calendar.create"]);
  const b = await body<{ date?: string }>(req);
  const date = b.date && /^\d{4}-\d\d-\d\d$/.test(b.date) ? b.date : localDate(Date.now(), me.tz || "UTC");
  return Response.json({ date, ...(await planDay(me, date)) });
}

export const POST = route(POST_);
