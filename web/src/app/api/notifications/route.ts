import { db } from "@/lib/db";
import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";

/** The notifications inbox: newest first, with an unread count. */
async function GET_() {
  const user = await requireUser();
  const [items, unread] = await Promise.all([
    db.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  return Response.json({ items, unread });
}

/** { ids } marks those read; { all: true } marks everything read. */
async function POST_(req: Request) {
  const user = await requireUser();
  const { ids, all } = (await req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean };
  await db.notification.updateMany({
    where: { userId: user.id, readAt: null, ...(all ? {} : { id: { in: ids ?? [] } }) },
    data: { readAt: new Date() },
  });
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
