import { requireMe } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/cal-plus";
import { body, route } from "@/lib/http";

/** GET -> { settings } · PUT { weekStart, timeFormat, defaultMinutes, defaultReminders, secondTz, showWeekends, showDeclined, hours, location, tz } */
async function GET_() {
  const me = await requireMe("calendar.open");
  return Response.json({ settings: await getSettings(me) });
}
async function PUT_(req: Request) {
  const me = await requireMe("calendar.open");
  return Response.json({ settings: await saveSettings(me, await body(req)) });
}

export const GET = route(GET_);
export const PUT = route(PUT_);
