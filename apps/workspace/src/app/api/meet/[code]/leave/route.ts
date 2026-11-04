import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode, leaveMeeting } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/** POST { transferTo? } -> I'm leaving: if I was the last host, someone else gets host controls. */
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ transferTo?: string }>(req);
  return Response.json(await leaveMeeting(await getMe(), m, key(req), b.transferTo));
}

export const POST = route(POST_);
