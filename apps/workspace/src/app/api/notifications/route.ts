import { db } from "@/lib/db";
import { requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";

/** GET -> my latest notifications and unread count. POST { action: "read", ids? } -> mark read (all when no ids). */
async function GET_() {
  const me = await requireMe();
  const [items, unread] = await Promise.all([
    db.notification.findMany({ where: { ws: me.ws, userId: me.userId }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.notification.count({ where: { ws: me.ws, userId: me.userId, readAt: null } }),
  ]);
  return Response.json({ items, unread });
}

async function POST_(req: Request) {
  const me = await requireMe();
  const b = await body<{ action?: string; ids?: string[] }>(req);
  if (b.action !== "read") return Response.json({ error: "Unknown action" }, { status: 400 });
  await db.notification.updateMany({ where: { ws: me.ws, userId: me.userId, readAt: null, ...(b.ids?.length ? { id: { in: b.ids } } : {}) }, data: { readAt: new Date() } });
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
