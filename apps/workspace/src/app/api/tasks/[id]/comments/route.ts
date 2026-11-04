import { requireMe } from "@/lib/auth";
import { addComment } from "@/lib/tasks";
import { body, route } from "@/lib/http";

/** POST { body } -> { comment } (@mentions of project members notify them and make them watchers) */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  const b = await body<{ body?: string }>(req);
  return Response.json({ comment: await addComment(me, (await ctx.params).id, String(b.body ?? "")) }, { status: 201 });
}

export const POST = route(POST_);
