import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode } from "@/lib/meet/meetings";
import { listRegistrants, registerLink, registrantAction } from "@/lib/meet/webinar";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };
const key = (req: Request) => req.headers.get("x-meet-guest");

/**
 * Hosts: webinar registrations.
 * GET  -> { registrants, link }
 * POST { action: approve | deny | resend | remove, id | ids } (approve and resend email a new personal link)
 */
async function GET_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json({ registrants: await listRegistrants(await getMe(), m, key(req)), link: registerLink(m) });
}
async function POST_(req: Request, ctx: Ctx) {
  const m = await byCode((await ctx.params).code);
  return Response.json(await registrantAction(await getMe(), m, key(req), await body(req)));
}

export const GET = route(GET_);
export const POST = route(POST_);
