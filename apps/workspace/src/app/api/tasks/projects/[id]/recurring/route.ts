import { requireMe } from "@/lib/auth";
import { deleteRecurring, listRecurring, saveRecurring } from "@/lib/tasks-plan";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { recurring } · POST { id?, template: { title, …, dueInDays? }, rule: { every, interval, weekdays? }, startAt?, enabled? } · DELETE ?id= */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ recurring: await listRecurring(me, (await ctx.params).id) });
}
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe(["tasks.open", "tasks.create"]);
  return Response.json({ recurring: await saveRecurring(me, (await ctx.params).id, await body(req)) }, { status: 201 });
}
async function DELETE_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteRecurring(me, (await ctx.params).id, new URL(req.url).searchParams.get("id") ?? ""));
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
