import { requireMe } from "@/lib/auth";
import { deleteRule, listRules, saveRule } from "@/lib/tasks-plan";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { rules } · POST { id?, name, trigger: { on, status? }, actions: [{ do, value }], enabled? } · DELETE ?id= */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ rules: await listRules(me, (await ctx.params).id) });
}
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ rule: await saveRule(me, (await ctx.params).id, await body(req)) }, { status: 201 });
}
async function DELETE_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteRule(me, (await ctx.params).id, new URL(req.url).searchParams.get("id") ?? ""));
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
