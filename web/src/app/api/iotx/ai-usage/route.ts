import { recordUsage } from "@/lib/ai-meter";
import { forbidden, serviceKeyOk } from "@/lib/iotx/service-key";

/**
 * POST /api/iotx/ai-usage   header x-iotx-key: <IOTX_SERVICE_KEY>
 * Claude calls made by Workspace (Calendar, Chat, Meet), metered there and
 * recorded here with the suite's own: { rows: [{ feature, model, status, ms,
 * input, output, cacheWrite, cacheRead, searches, workspaceId, userId, requestId }] }.
 */
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 2_000_000_000) : 0);
const s = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);

export async function POST(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const body = (await req.json().catch(() => ({}))) as { rows?: Record<string, unknown>[] };
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 200) : [];
  for (const r of rows) {
    await recordUsage({
      app: "workspace",
      feature: s(r.feature, 60) ?? "Workspace",
      model: s(r.model, 80) ?? "",
      status: n(r.status) || 200,
      ms: n(r.ms),
      input: n(r.input),
      output: n(r.output),
      cacheWrite: n(r.cacheWrite),
      cacheRead: n(r.cacheRead),
      searches: n(r.searches),
      workspaceId: s(r.workspaceId, 60),
      userId: s(r.userId, 60),
      projectId: null,
      requestId: s(r.requestId, 120),
    });
  }
  return Response.json({ ok: true, recorded: rows.length });
}
