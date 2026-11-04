import { requireMe } from "@/lib/auth";
import { addOther, setSub } from "@/lib/cal-plus";
import { body, route } from "@/lib/http";

/** POST { userId | calendarId } adds someone's calendar to my list · PATCH { calendarId, color?, hidden?, remove? } */
async function POST_(req: Request) {
  const me = await requireMe("calendar.open");
  return Response.json(await addOther(me, await body(req)), { status: 201 });
}
async function PATCH_(req: Request) {
  const me = await requireMe("calendar.open");
  const b = await body<{ calendarId?: string; color?: string; hidden?: boolean; remove?: boolean }>(req);
  return Response.json(await setSub(me, String(b.calendarId ?? ""), b));
}

export const POST = route(POST_);
export const PATCH = route(PATCH_);
