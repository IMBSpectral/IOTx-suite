import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { listChat, postChat } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/**
 * GET  -> { messages } (everyone's, plus private ones to or from me); after the meeting, for members who were in it
 * POST { text, to?, fileIds?, room? } -> { message } (to = an identity: a private message)
 */
async function GET_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ messages: await listChat(await getMe(), m, key(req)) });
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ message: await postChat(await getMe(), m, key(req), await body(req)) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
