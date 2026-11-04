import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { board, boardAction } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/** GET -> { strokes } · POST { stroke } adds one · POST { action: "clear" } (hosts). Live drawing goes over the data channel. */
async function GET_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ strokes: await board(await getMe(), m, key(req)) });
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await boardAction(await getMe(), m, key(req), await body(req)));
}

export const GET = route(GET_);
export const POST = route(POST_);
