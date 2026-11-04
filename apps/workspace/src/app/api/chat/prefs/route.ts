import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { prefsOf, presenceMap, presenceOf, savePrefs } from "@/lib/presence";
import { body, route } from "@/lib/http";

/**
 * GET -> { prefs, presence: { userId: { presence, status, emoji } } }
 * POST { status?, emoji?, until?, away?, dndUntil?, email?, desktop? } -> { prefs }
 */
async function GET_() {
  const me = await requireMe("teamchat.open");
  const u = await db.user.findUnique({ where: { id: me.userId }, select: { chatPrefs: true } });
  const p = prefsOf(u?.chatPrefs);
  return Response.json({ prefs: { ...p, presence: presenceOf(me.ws, me.userId, p) }, presence: await presenceMap(me.ws) });
}
async function POST_(req: Request) {
  const me = await requireMe("teamchat.open");
  return Response.json({ prefs: await savePrefs(me.ws, me.userId, await body(req)) });
}

export const GET = route(GET_);
export const POST = route(POST_);
