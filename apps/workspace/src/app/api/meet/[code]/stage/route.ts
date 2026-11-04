import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { attendees, setStage } from "@/lib/meet/webinar";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/**
 * Hosts of a webinar.
 * GET  -> { attendees (raised hands first), stage, count, cap }
 * POST { identity, on } -> bring them on stage (they may publish) or back to the audience
 */
async function GET_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await attendees(await getMe(), m, key(req)));
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await setStage(await getMe(), m, key(req), await body(req)));
}

export const GET = route(GET_);
export const POST = route(POST_);
