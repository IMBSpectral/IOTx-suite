import { db } from "@/lib/db";
import { requireMe, isZone } from "@/lib/auth";
import { body, route } from "@/lib/http";

/** GET -> who am I, my permissions. POST { tz } -> set my time zone. */
async function GET_() {
  const me = await requireMe();
  return Response.json({ me: { id: me.userId, name: me.name, email: me.email, tz: me.tz, ws: me.ws, owner: me.owner, perms: me.perms } });
}

async function POST_(req: Request) {
  const me = await requireMe();
  const b = await body<{ tz?: string }>(req);
  if (b.tz && isZone(b.tz)) await db.user.update({ where: { id: me.userId }, data: { tz: b.tz } });
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
