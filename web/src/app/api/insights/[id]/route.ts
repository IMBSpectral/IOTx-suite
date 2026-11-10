import { analysisFor, insightsRoute } from "@/lib/insights/http";
import { randomUUID } from "node:crypto";
import { deleteAnalysis, saveAnalysis, withLock, type Link, type Widget } from "@/lib/insights/store";
import { closeAnalysis, query } from "@/lib/insights/engine";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { analysis, busy } · PATCH { name?, board?, link? } · DELETE */
export const GET = insightsRoute(async (_req: Request, { params }: Ctx) => {
  const { a } = await analysisFor((await params).id);
  // busy: the analyst is still working on a message (the page polls this after a dropped connection).
  return Response.json({ analysis: a, busy: !!(globalThis as { __insightsRunning?: Set<string> }).__insightsRunning?.has(a.id) });
});

export const PATCH = insightsRoute(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    board?: Partial<Widget>[];
    link?: { from: { table: string; column: string }; to: { table: string; column: string }; off?: boolean };
  };
  await analysisFor(id);
  const a = await withLock(id, async () => {
    const { a } = await analysisFor(id);
    if (typeof body.name === "string" && body.name.trim()) a.name = body.name.replace(/\s+/g, " ").trim().slice(0, 120);
    // The data map: a person links two columns, or turns a link on or off.
    const L = body.link;
    if (L?.from?.table && L.from.column && L.to?.table && L.to.column) {
      const has = (p: { table: string; column: string }) => a.tables.some((t) => t.name === p.table && t.columns.some((c) => c.name === p.column));
      if (!has(L.from) || !has(L.to)) return a;
      const same = (l: Link) =>
        (l.from.table === L.from.table && l.from.column === L.from.column && l.to.table === L.to.table && l.to.column === L.to.column) ||
        (l.to.table === L.from.table && l.to.column === L.from.column && l.from.table === L.to.table && l.from.column === L.to.column);
      const old = (a.links ?? []).find(same);
      const qq = (n: string) => `"${n.replace(/"/g, '""')}"`;
      const r = old
        ? null
        : await query(
            a,
            `SELECT count(DISTINCT x.v) FROM (SELECT lower(trim(CAST(${qq(L.from.column)} AS VARCHAR))) v FROM ${qq(L.from.table)}) x JOIN (SELECT lower(trim(CAST(${qq(L.to.column)} AS VARCHAR))) v FROM ${qq(L.to.table)}) y USING (v)`,
            { limit: 1 },
          ).catch(() => null);
      const link: Link = old
        ? { ...old, off: !!L.off, by: old.by === "auto" && !L.off ? "auto" : "user" }
        : { id: randomUUID().slice(0, 8), from: { table: L.from.table, column: L.from.column }, to: { table: L.to.table, column: L.to.column }, match: 0, shared: Number(r?.rows[0]?.[0] ?? 0), kind: "n:n", by: "user", off: !!L.off };
      a.links = [...(a.links ?? []).filter((l) => !same(l)), link];
    }
    // The board can be reordered, resized, renamed or trimmed here; charts themselves are only made by the AI.
    if (Array.isArray(body.board)) {
      const byId = new Map(a.board.map((w) => [w.id, w]));
      a.board = body.board
        .filter((w) => w && typeof w.id === "string" && byId.has(w.id))
        .map((w) => {
          const old = byId.get(w.id!)!;
          return {
            ...old,
            size: Math.min(12, Math.max(2, Math.round(Number(w.size) || old.size || 6))),
            title: typeof w.title === "string" && w.title.trim() ? w.title.slice(0, 140) : old.title,
          };
        });
    }
    return saveAnalysis(a);
  });
  return Response.json({ analysis: a });
});

export const DELETE = insightsRoute(async (_req: Request, { params }: Ctx) => {
  const { a } = await analysisFor((await params).id);
  await closeAnalysis(a);
  await deleteAnalysis(a);
  return Response.json({ ok: true });
});
