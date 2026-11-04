import { db } from "@/lib/db";
import { route } from "@/lib/route";
import { forbidden, serviceKeyOk } from "@/lib/iotx/service-key";
import { canRead, consult, formatHits, KbError, search, suggest, viewer } from "@/lib/kb";

/**
 * Company knowledge for the IOTx apps that run as their own process
 * (Calendar, Tasks, Chat, Meet in apps/workspace). Server to server (x-iotx-key):
 *
 *   POST { userId, ws?, query, limit? } -> { hits, context }
 *   POST { userId, ws?, query, consult: true, context?, tool?, cite?, shared? } -> { hits, context }
 *   POST { userId, ws, suggest: { title, body, reason?, sourceRef? } } -> 201 { suggestion }  (read.suggest)
 *
 * Only articles that person may read; empty when the Read app is off for them.
 * A search's `context` is the hits formatted for a prompt, with numbered
 * sources. A suggestion (Meet's "suggest decisions to the knowledge base")
 * goes into the review queue as that person, source "assistant". A consult (the "knowledge first" step before an AI acts) returns
 * the suite's ready "Company knowledge" block, which also says when nothing matched.
 */
async function POST_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const b = (await req.json().catch(() => ({}))) as { userId?: string; ws?: string; query?: string; limit?: number; consult?: boolean; context?: string; tool?: boolean; cite?: boolean; shared?: boolean; suggest?: { title?: string; body?: string; reason?: string; sourceRef?: string } };
  if (b.suggest && b.userId && b.ws) {
    const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: b.userId, workspaceId: b.ws } } });
    if (!m) return Response.json({ error: "Not in this workspace." }, { status: 403 });
    const v = await viewer(b.userId, b.ws);
    if (!v.e?.keys.includes("read.suggest")) return Response.json({ error: "Your role can't suggest knowledge updates." }, { status: 403 });
    try {
      const s = await suggest(v, { title: b.suggest.title, body: b.suggest.body, reason: b.suggest.reason, source: "assistant", sourceRef: b.suggest.sourceRef ? String(b.suggest.sourceRef).slice(0, 200) : null });
      return Response.json({ suggestion: { id: s.id, status: s.status } }, { status: 201 });
    } catch (e) {
      if (e instanceof KbError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }
  if (!b.userId || (!b.query && !b.consult)) return Response.json({ error: "userId and query are required" }, { status: 400 });
  const membership = b.ws
    ? await db.membership.findUnique({ where: { userId_workspaceId: { userId: b.userId, workspaceId: b.ws } } })
    : await db.membership.findFirst({ where: { userId: b.userId }, orderBy: { createdAt: "asc" } });
  if (!membership) return Response.json({ hits: [], context: "" });
  const v = await viewer(b.userId, membership.workspaceId);
  if (!canRead(v)) return Response.json({ hits: [], context: "" });
  if (b.consult) {
    const c = await consult(v, String(b.query ?? ""), { context: b.context, tool: !!b.tool, cite: b.cite !== false, shared: !!b.shared });
    return Response.json(c, { headers: { "cache-control": "no-store" } });
  }
  const hits = await search(v, String(b.query), { limit: Math.min(12, Number(b.limit) || 6), platform: true });
  return Response.json({ hits, context: formatHits(hits, 8000) }, { headers: { "cache-control": "no-store" } });
}

export const POST = route(POST_);
