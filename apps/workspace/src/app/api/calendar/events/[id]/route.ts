import { db } from "@/lib/db";
import { can, requireMe } from "@/lib/auth";
import { deleteEvent, guestWarnings, loadEvent, updateEvent, type EventInput } from "@/lib/calendar";
import { afterLocalChange } from "@/lib/google";
import { body, route } from "@/lib/http";
import { linkEvent, meetingForEvent } from "@/lib/meet/meetings";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { event } */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("calendar.open");
  const { id } = await ctx.params;
  const ev = await loadEvent(me, id);
  const { calendar: _c, ...rest } = ev;
  return Response.json({ event: rest });
}

/** PATCH EventInput & { scope?: "this" | "following" | "all", occ?: ISO } -> { event, warnings } */
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("calendar.open");
  const { id } = await ctx.params;
  const b = await body<EventInput & { scope?: "this" | "following" | "all"; occ?: string; videoMeeting?: boolean }>(req);
  const vm = b.videoMeeting ? await meetingForEvent(me, req, b) : null;
  const ev = await updateEvent(me, id, vm ? { ...b, conferenceUrl: vm.url } : b, b.scope === "this" || b.scope === "following" ? b.scope : "all", b.occ);
  if (vm) await linkEvent(vm.id, ev.id);
  await afterLocalChange(me.userId, me.ws, ev.id, can(me, "calendar.google"));
  const guests = (await db.attendee.findMany({ where: { eventId: ev.id, userId: { not: null } }, select: { userId: true } })).map((a) => a.userId!);
  return Response.json({ event: ev, warnings: await guestWarnings(me, ev, guests) });
}

/** DELETE ?scope=this|following|all&occ=ISO */
async function DELETE_(req: Request, ctx: Ctx) {
  const me = await requireMe("calendar.open");
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const sc = q.get("scope");
  const r = await deleteEvent(me, id, sc === "this" || sc === "following" ? sc : "all", q.get("occ") ?? undefined);
  const target = r.series?.id ?? id;
  await afterLocalChange(me.userId, me.ws, target, can(me, "calendar.google"));
  // A deleted series takes its changed occurrences with it.
  if (!r.series) {
    const exs = await db.event.findMany({ where: { recurringId: id, googleId: { not: null } }, select: { id: true } });
    for (const x of exs) await afterLocalChange(me.userId, me.ws, x.id, can(me, "calendar.google"));
  }
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
