import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode, decide, lobby } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/**
 * GET  -> { waiting: [{ id, name, since, kind }] } (hosts and co-hosts)
 * POST { participantId, action: "admit"|"deny" } or { all: true, action } (host)
 */
async function GET_(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ waiting: await lobby(await getMe(), m, _req.headers.get("x-meet-guest")) });
}

async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ participantId?: string; all?: boolean; action?: string }>(req);
  return Response.json(await decide(await getMe(), m, b, req.headers.get("x-meet-guest")));
}

export const GET = route(GET_);
export const POST = route(POST_);
