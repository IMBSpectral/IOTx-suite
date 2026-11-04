import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { breakoutAction, breakoutState } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/**
 * GET  -> { breakout, mine, hostLike }
 * POST { action: "create", count, auto?, allowChoose?, names? } | "assign" { identity, n|null } | "options" { allowChoose }
 *      | "open" | "broadcast" { text } | "close" | "delete"   (hosts)
 *      { action: "token", n } -> a token for room n (0 = the main room)
 */
async function GET_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await breakoutState(await getMe(), m, key(req)));
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await breakoutAction(await getMe(), m, key(req), await body(req)));
}

export const GET = route(GET_);
export const POST = route(POST_);
