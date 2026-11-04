import { requireMe } from "@/lib/auth";
import { createSprint, listSprints } from "@/lib/tasks-plan";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { sprints } · POST { name?, goal?, startAt?, endAt? } -> a planned sprint */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ sprints: await listSprints(me, (await ctx.params).id) });
}
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ sprint: await createSprint(me, (await ctx.params).id, await body(req)) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
