import { requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { suiteCall } from "@/lib/suite";

/**
 * The suite's bell, from Calendar, Tasks and Chat pages (one bell for everything).
 * GET -> { items, unread } from the suite. POST { ids? , all? } -> mark read there.
 */
async function GET_() {
  const me = await requireMe();
  const r = await suiteCall<{ items?: unknown[]; unread?: number }>(`/api/iotx/notify?userId=${encodeURIComponent(me.userId)}`).catch(() => null);
  if (!r || r.status !== 200) return Response.json({ items: [], unread: 0, offline: true });
  return Response.json({ items: r.data.items ?? [], unread: r.data.unread ?? 0 });
}

async function POST_(req: Request) {
  const me = await requireMe();
  const b = await body<{ ids?: string[]; all?: boolean }>(req);
  const r = await suiteCall("/api/iotx/notify", { method: "PATCH", body: { userId: me.userId, ids: b.ids, all: !!b.all } }).catch(() => null);
  return Response.json({ ok: r?.status === 200 });
}

export const GET = route(GET_);
export const POST = route(POST_);
