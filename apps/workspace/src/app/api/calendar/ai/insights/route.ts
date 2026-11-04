import { requireMe } from "@/lib/auth";
import { addDaysStr, issues, localDate } from "@/lib/cal-smart";
import { route } from "@/lib/http";

/** GET ?from=YYYY-MM-DD&to=YYYY-MM-DD -> { issues } double-bookings, outside working hours, back-to-back runs, overloaded days, each with a suggested fix where one exists. */
async function GET_(req: Request) {
  const me = await requireMe("calendar.open");
  const q = new URL(req.url).searchParams;
  const ok = (s: string | null) => !!s && /^\d{4}-\d\d-\d\d$/.test(s);
  const from = ok(q.get("from")) ? q.get("from")! : localDate(Date.now(), me.tz || "UTC");
  let to = ok(q.get("to")) ? q.get("to")! : addDaysStr(from, 6);
  if (to < from) to = from;
  if (to > addDaysStr(from, 41)) to = addDaysStr(from, 41);
  return Response.json({ from, to, issues: await issues(me, from, to) });
}

export const GET = route(GET_);
