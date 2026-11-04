import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { translate } from "@/lib/meet/extras";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/** POST { lines: string[], lang } -> { lines } translated captions (for the person asking). */
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await translate(await getMe(), m, key(req), await body(req)));
}

export const POST = route(POST_);
