import { can, requireMe } from "@/lib/auth";
import { acceptProposal } from "@/lib/calendar";
import { afterLocalChange } from "@/lib/google";
import { body, route } from "@/lib/http";

/** POST { email } -> the organizer takes that guest's proposed time */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("calendar.open");
  const ev = await acceptProposal(me, (await ctx.params).id, String((await body<{ email?: string }>(req)).email ?? ""));
  await afterLocalChange(me.userId, me.ws, ev.id, can(me, "calendar.google"));
  return Response.json({ event: ev });
}

export const POST = route(POST_);
