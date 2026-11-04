import { body, route } from "@/lib/http";
import { finishCapture, tokenMe } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/** POST (Bearer) { title?, participants? } -> status; the report is made in the background (poll GET …/capture/<id>). */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { me } = await tokenMe(req);
  return Response.json(await finishCapture(me, (await ctx.params).id, await body(req)));
}

export const POST = route(POST_);
