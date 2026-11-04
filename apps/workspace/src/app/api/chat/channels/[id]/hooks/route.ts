import { requireMe } from "@/lib/auth";
import { createHook, listHooks } from "@/lib/chat";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { hooks } · POST { name } -> { hook: { id, name, token } } (the token is shown once) */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  return Response.json({ hooks: await listHooks(me, (await ctx.params).id) });
}
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  const b = await body<{ name?: string }>(req);
  return Response.json({ hook: await createHook(me, (await ctx.params).id, String(b.name ?? "")) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
