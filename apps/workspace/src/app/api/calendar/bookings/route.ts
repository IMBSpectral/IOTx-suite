import { requireMe } from "@/lib/auth";
import { deleteBooking, listBookings, saveBooking } from "@/lib/cal-plus";
import { body, route } from "@/lib/http";

/** My booking pages: GET -> { pages } · POST { id?, title, minutes, hours, … } · DELETE ?id= */
async function GET_() {
  const me = await requireMe(["calendar.open", "calendar.create"]);
  return Response.json({ pages: await listBookings(me) });
}
async function POST_(req: Request) {
  const me = await requireMe(["calendar.open", "calendar.create"]);
  return Response.json({ page: await saveBooking(me, await body(req)) }, { status: 201 });
}
async function DELETE_(req: Request) {
  const me = await requireMe(["calendar.open", "calendar.create"]);
  return Response.json(await deleteBooking(me, new URL(req.url).searchParams.get("id") ?? ""));
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
