import { analysisFor, insightsRoute } from "@/lib/insights/http";
import { deleteAnalysis, saveAnalysis, withLock, type Widget } from "@/lib/insights/store";
import { closeAnalysis } from "@/lib/insights/engine";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { analysis } · PATCH { name?, board? } · DELETE */
export const GET = insightsRoute(async (_req: Request, { params }: Ctx) => {
  const { a } = await analysisFor((await params).id);
  return Response.json({ analysis: a });
});

export const PATCH = insightsRoute(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: string; board?: Partial<Widget>[] };
  await analysisFor(id);
  const a = await withLock(id, async () => {
    const { a } = await analysisFor(id);
    if (typeof body.name === "string" && body.name.trim()) a.name = body.name.replace(/\s+/g, " ").trim().slice(0, 120);
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
