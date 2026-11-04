import { getMe } from "@/lib/auth";
import { bad, body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { startStream, stopStream, streams } from "@/lib/meet/webinar";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/**
 * Live streaming to RTMP (the host, with the recording switch).
 * GET  -> { enabled, streams }
 * POST { action: "start", url, key?, layout? } | { action: "stop", id? }
 * The stream key is used once and never stored.
 */
async function GET_(_req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await streams(await getMe(), m));
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ action?: string; url?: string; key?: string; layout?: string; id?: string }>(req);
  const me = await getMe();
  if (b.action === "start") return Response.json({ stream: await startStream(me, m, b) }, { status: 201 });
  if (b.action === "stop") return Response.json(await stopStream(me, m, b.id));
  bad("action must be start or stop");
}

export const GET = route(GET_);
export const POST = route(POST_);
