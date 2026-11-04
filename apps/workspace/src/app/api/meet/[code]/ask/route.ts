import { getMe, HttpError } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { askMeeting, canSeeMeetingReport } from "@/lib/meet/report";

export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __meetAsk?: Map<string, number[]> };
const rate: Map<string, number[]> = (g.__meetAsk ??= new Map());

/** POST { question } -> { answer, found, citations: seconds[] } from this meeting's transcript and report only. */
async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  if (!me || !(await canSeeMeetingReport(me, m))) throw new HttpError(404, "Not found");
  const now = Date.now();
  const hits = (rate.get(me.userId) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 20) throw new HttpError(429, "Too many questions. Wait a minute.");
  rate.set(me.userId, [...hits, now]);
  const b = await body<{ question?: string }>(req);
  return Response.json(await askMeeting(me, m, String(b.question ?? "")));
}

export const POST = route(POST_);
