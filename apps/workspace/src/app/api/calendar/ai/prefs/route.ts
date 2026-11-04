import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { cleanHours } from "@/lib/cal-smart";
import { body, route } from "@/lib/http";

/** GET -> { hours } my working hours (defaults 09:30-18:30 Mon-Sat). POST WorkHours -> save. */
async function GET_() {
  const me = await requireMe("calendar.open");
  const u = await db.user.findUnique({ where: { id: me.userId }, select: { workHours: true } });
  return Response.json({ hours: cleanHours(u?.workHours), tz: me.tz });
}

async function POST_(req: Request) {
  const me = await requireMe("calendar.open");
  const hours = cleanHours(await body(req));
  await db.user.update({ where: { id: me.userId }, data: { workHours: hours } });
  return Response.json({ hours });
}

export const GET = route(GET_);
export const POST = route(POST_);
