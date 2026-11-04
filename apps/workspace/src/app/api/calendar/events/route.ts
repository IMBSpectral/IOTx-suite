import { can, requireMe } from "@/lib/auth";
import { createEvent, guestWarnings, type EventInput } from "@/lib/calendar";
import { db } from "@/lib/db";
import { afterLocalChange } from "@/lib/google";
import { body, route } from "@/lib/http";
import { linkEvent, meetingForEvent } from "@/lib/meet/meetings";

/** POST EventInput & { videoMeeting? } -> { event, warnings }. videoMeeting: an IOTx Meet meeting becomes the event's link. */
async function POST_(req: Request) {
  const me = await requireMe(["calendar.open", "calendar.create"]);
  const b = await body<EventInput & { videoMeeting?: boolean }>(req);
  const vm = b.videoMeeting ? await meetingForEvent(me, req, b) : null;
  const ev = await createEvent(me, vm ? { ...b, conferenceUrl: vm.url } : b);
  if (vm) await linkEvent(vm.id, ev.id);
  await afterLocalChange(me.userId, me.ws, ev.id, can(me, "calendar.google"));
  const guests = (await db.attendee.findMany({ where: { eventId: ev.id, userId: { not: null } }, select: { userId: true } })).map((a) => a.userId!);
  return Response.json({ event: ev, warnings: await guestWarnings(me, ev, guests) }, { status: 201 });
}

export const POST = route(POST_);
