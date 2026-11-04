import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { listQuestions, questionAction } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/**
 * GET  -> { questions } most upvoted first
 * POST { action: "ask", text, anonymous? } | { action: "upvote", id } | { action: "answer", id, answer } | { action: "dismiss"|"reopen"|"delete", id }
 */
async function GET_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ questions: await listQuestions(await getMe(), m, key(req)) });
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await questionAction(await getMe(), m, key(req), await body(req)));
}

export const GET = route(GET_);
export const POST = route(POST_);
