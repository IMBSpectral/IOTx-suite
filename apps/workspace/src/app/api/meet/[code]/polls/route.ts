import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { listPolls, pollAction } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/**
 * GET  -> { polls } (hosts see drafts and live results; others see results once shared)
 * POST { action: "create", question, options, multi?, anonymous?, open? } | { action: "open"|"close"|"share"|"unshare"|"delete", id } (hosts)
 *      { action: "vote", id, choices: number[] } (anyone in the meeting)
 */
async function GET_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ polls: await listPolls(await getMe(), m, key(req)) });
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await pollAction(await getMe(), m, key(req), await body(req)));
}

export const GET = route(GET_);
export const POST = route(POST_);
