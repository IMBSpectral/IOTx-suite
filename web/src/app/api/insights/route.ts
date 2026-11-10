import { insightsRoute, viewer } from "@/lib/insights/http";
import { createAnalysis, listAnalyses, summary } from "@/lib/insights/store";

/** GET -> { analyses } · POST { name? } -> { analysis } */
export const GET = insightsRoute(async () => {
  const v = await viewer();
  return Response.json({ analyses: (await listAnalyses(v.workspaceId, v.userId)).map(summary) });
});

export const POST = insightsRoute(async (req: Request) => {
  const v = await viewer("insights.upload");
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  return Response.json({ analysis: await createAnalysis(v.workspaceId, v.userId, body.name) });
});
