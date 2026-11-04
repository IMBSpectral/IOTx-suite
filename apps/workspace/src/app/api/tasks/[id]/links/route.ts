import { requireMe } from "@/lib/auth";
import { addLink } from "@/lib/tasks";
import { body, route } from "@/lib/http";

/** POST { kind: blocks | relates | duplicates | clones, other: id or key } -> { link } */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  const b = await body<{ kind?: string; other?: string }>(req);
  return Response.json({ link: await addLink(me, (await ctx.params).id, String(b.kind ?? ""), String(b.other ?? "")) }, { status: 201 });
}

export const POST = route(POST_);
