import { requireMe } from "@/lib/auth";
import { respond } from "@/lib/calendar";
import { afterLocalChange } from "@/lib/google";
import { body, route } from "@/lib/http";

/** POST { response: "yes" | "no" | "maybe", comment?, proposeStart?, proposeEnd? } (a Google invitation's reply goes back to Google) */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("calendar.open");
  const { id } = await ctx.params;
  const b = await body<{ response?: string; comment?: string; proposeStart?: string; proposeEnd?: string }>(req);
  const r = await respond(me, id, String(b.response ?? ""), b);
  // The reply reaches the calendar owner's Google copy (only when that owner syncs with Google).
  await afterLocalChange(me.userId, me.ws, id, true);
  return Response.json(r);
}

export const POST = route(POST_);
