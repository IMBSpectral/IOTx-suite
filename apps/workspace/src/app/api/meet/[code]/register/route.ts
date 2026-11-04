import { body, route } from "@/lib/http";
import { byCode, clientIp } from "@/lib/meet/meetings";
import { register, registrationInfo } from "@/lib/meet/webinar";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/**
 * Public webinar registration (no sign-in).
 * GET  -> { webinar: { title, host, startsAt, open, approval } }
 * POST { name, email, company? } -> { ok, status: "approved" (link emailed) | "pending" (the host approves first) }
 */
async function GET_(_req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ webinar: await registrationInfo(m) });
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await register(m, await body(req), clientIp(req)), { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
