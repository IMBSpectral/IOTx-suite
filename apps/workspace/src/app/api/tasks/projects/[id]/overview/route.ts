import { requireMe } from "@/lib/auth";
import { insights, summary } from "@/lib/tasks-board";
import { route } from "@/lib/http";

/** GET ?kind=summary -> the project's front page · GET ?kind=insights -> board insights */
async function GET_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  const id = (await ctx.params).id;
  return Response.json(new URL(req.url).searchParams.get("kind") === "insights" ? await insights(me, id) : await summary(me, id));
}

export const GET = route(GET_);
