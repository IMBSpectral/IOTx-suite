import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { body, route, str } from "@/lib/http";
import { calendarList, createCalendar, deleteCalendar, updateCalendar } from "@/lib/cal-plus";

/**
 * GET -> { calendars } (mine, team, shared with me and added)
 * POST { name, color?, description?, kind?: "personal" | "team" } -> a new calendar (team needs calendar.team)
 * PATCH { id, name?, color?, description?, wsAccess?, shares?: [{ userId, role }], feed?: true | false | "reset" } (managers)
 * DELETE ?id=
 */
async function GET_() {
  const me = await requireMe("calendar.open");
  return Response.json({ calendars: await calendarList(me) });
}

async function POST_(req: Request) {
  const b = await body<{ name?: string; color?: string; description?: string; kind?: string }>(req);
  if (b.kind === "team") {
    const me = await requireMe(["calendar.open", "calendar.team"]);
    const name = str(b.name, 80) || "Team calendar";
    const color = b.color && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#0891b2";
    const cal = await db.calendar.create({ data: { ws: me.ws, kind: "team", name, color, description: str(b.description, 500), createdBy: me.userId, wsAccess: "read" } });
    return Response.json({ calendar: cal }, { status: 201 });
  }
  const me = await requireMe("calendar.open");
  return Response.json({ calendar: await createCalendar(me, b) }, { status: 201 });
}

async function PATCH_(req: Request) {
  const me = await requireMe("calendar.open");
  const b = await body<Record<string, unknown>>(req);
  return Response.json({ calendar: await updateCalendar(me, String(b.id ?? ""), b) });
}

async function DELETE_(req: Request) {
  const me = await requireMe("calendar.open");
  return Response.json(await deleteCalendar(me, new URL(req.url).searchParams.get("id") ?? ""));
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
