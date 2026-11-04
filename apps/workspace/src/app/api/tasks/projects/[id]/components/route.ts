import { requireMe } from "@/lib/auth";
import { deleteComponent, listComponents, saveComponent } from "@/lib/tasks-board";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { components } · POST { id?, name, description, leadId } · DELETE ?id= */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ components: await listComponents(me, (await ctx.params).id) });
}
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ component: await saveComponent(me, (await ctx.params).id, await body(req)) }, { status: 201 });
}
async function DELETE_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteComponent(me, (await ctx.params).id, new URL(req.url).searchParams.get("id") ?? ""));
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
