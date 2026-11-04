import { cancelBooking, rsvpAnswer, rsvpView } from "@/lib/cal-plus";
import { HttpError } from "@/lib/auth";
import { route } from "@/lib/http";

type Ctx = { params: Promise<{ token: string }> };

/**
 * For guests without an account (the link in their invitation is the key):
 * GET -> the event and my reply · POST { response, comment?, proposeStart?, proposeEnd? } · POST { cancel: true } (booked meetings)
 */
async function GET_(_req: Request, ctx: Ctx) {
  const v = await rsvpView((await ctx.params).token);
  if (!v) throw new HttpError(404, "This invitation is no longer available.");
  return Response.json(v, { headers: { "cache-control": "no-store" } });
}
async function POST_(req: Request, ctx: Ctx) {
  const token = (await ctx.params).token;
  const b = (await req.json().catch(() => ({}))) as { response?: string; comment?: string; proposeStart?: string; proposeEnd?: string; cancel?: boolean };
  if (b.cancel) return Response.json(await cancelBooking(token));
  return Response.json(await rsvpAnswer(token, b));
}

export const GET = route(GET_);
export const POST = route(POST_);
