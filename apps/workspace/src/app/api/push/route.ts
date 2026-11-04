import { requireMe } from "@/lib/auth";
import { db } from "@/lib/db";
import { subscribe, unsubscribe, vapid } from "@/lib/push";
import { body, route } from "@/lib/http";

/**
 * Web Push for this person's devices:
 * GET    -> { publicKey, devices }
 * POST   { subscription } -> saves this browser (PushSubscription.toJSON())
 * DELETE { endpoint }     -> forgets it
 */
async function GET_() {
  const me = await requireMe();
  return Response.json({ publicKey: (await vapid()).publicKey, devices: await db.pushSub.count({ where: { userId: me.userId } }) });
}
async function POST_(req: Request) {
  const me = await requireMe();
  const b = await body<{ subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>(req);
  await subscribe(me, b.subscription ?? {}, req.headers.get("user-agent") ?? "");
  return Response.json({ ok: true }, { status: 201 });
}
async function DELETE_(req: Request) {
  const me = await requireMe();
  const b = await body<{ endpoint?: string }>(req);
  return Response.json({ ok: true, removed: await unsubscribe(me.userId, String(b.endpoint ?? "")) });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
