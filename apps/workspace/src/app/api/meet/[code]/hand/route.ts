import { getMe, HttpError } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode, callerParticipant, setHand } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/** POST { up: boolean, key? } -> raise or lower my hand (members by session, guests by key). */
async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ up?: boolean; key?: string }>(req);
  const p = await callerParticipant(await getMe(), m, b.key || req.headers.get("x-meet-guest"));
  if (!p || p.status !== "admitted") throw new HttpError(403, "Join the meeting first.");
  return Response.json(await setHand(m, p.identity, !!b.up));
}

export const POST = route(POST_);
