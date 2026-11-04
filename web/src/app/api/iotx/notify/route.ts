import { db } from "@/lib/db";
import { route } from "@/lib/route";
import { forbidden, serviceKeyOk } from "@/lib/iotx/service-key";

/**
 * One bell for the whole suite. Server to server (x-iotx-key), for IOTx apps
 * that run as their own process (Calendar, Tasks and Chat in apps/workspace):
 *
 *   POST  { userId, title, body?, href, kind? }  -> 201 { id }   (adds to the suite's notifications)
 *   GET   ?userId=                               -> { items, unread }  (what the suite bell shows)
 *   PATCH { userId, ids?: string[], all?: true } -> { ok }        (mark read)
 *
 * `href` must be a path on this site (Workspace sends /workspace/...), so it
 * opens from any suite page.
 */
const isPath = (s: unknown): s is string => typeof s === "string" && s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") && s.length <= 1000;

async function POST_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const b = (await req.json().catch(() => ({}))) as { userId?: string; title?: string; body?: string; href?: string; kind?: string };
  if (!b.userId || typeof b.title !== "string" || !b.title.trim()) return Response.json({ error: "userId and title are required" }, { status: 400 });
  if (b.href !== undefined && b.href !== null && b.href !== "" && !isPath(b.href)) return Response.json({ error: "href must be a path on this site" }, { status: 400 });
  const user = await db.user.findUnique({ where: { id: b.userId }, select: { id: true } });
  if (!user) return Response.json({ error: "Unknown user" }, { status: 404 });
  const kind = typeof b.kind === "string" && /^[a-z][a-z0-9._-]{0,40}$/.test(b.kind) ? b.kind : "workspace";
  const row = await db.notification.create({
    data: { userId: user.id, kind, title: b.title.trim().slice(0, 200), body: typeof b.body === "string" && b.body.trim() ? b.body.trim().slice(0, 500) : null, href: b.href || null },
  });
  return Response.json({ id: row.id }, { status: 201 });
}

async function GET_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });
  const [items, unread] = await Promise.all([
    db.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.notification.count({ where: { userId, readAt: null } }),
  ]);
  return Response.json({ items, unread }, { headers: { "cache-control": "no-store" } });
}

async function PATCH_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const b = (await req.json().catch(() => ({}))) as { userId?: string; ids?: string[]; all?: boolean };
  if (!b.userId) return Response.json({ error: "userId is required" }, { status: 400 });
  await db.notification.updateMany({
    where: { userId: b.userId, readAt: null, ...(b.all ? {} : { id: { in: Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string").slice(0, 200) : [] } }) },
    data: { readAt: new Date() },
  });
  return Response.json({ ok: true });
}

export const POST = route(POST_);
export const GET = route(GET_);
export const PATCH = route(PATCH_);
