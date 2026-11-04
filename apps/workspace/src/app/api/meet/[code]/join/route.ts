import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode, clientIp, isMember, joinGuest, joinMember } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/**
 * POST { name?, key?, asGuest?, passcode?, reg? }  (reg: a webinar registrant's emailed link secret)
 * Members of the meeting's workspace (Workspace session): a LiveKit token.
 * Guests: { name } -> { status: "waiting", key } (or a token when there's no
 * waiting room); then { key } again until admitted -> { status: "admitted", token, url }.
 * The guest key may also come in the x-meet-guest header.
 */
async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ name?: string; key?: string; asGuest?: boolean; passcode?: string; reg?: string }>(req);
  const key = b.key || req.headers.get("x-meet-guest") || undefined;
  const me = await getMe();
  if (isMember(me, m) && !key && !b.asGuest) return Response.json(await joinMember(me, m));
  return Response.json(await joinGuest(m, { name: b.name, key, passcode: b.passcode, reg: b.reg }, clientIp(req)));
}

export const POST = route(POST_);
