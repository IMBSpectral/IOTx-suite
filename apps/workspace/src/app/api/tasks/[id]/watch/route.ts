import { requireMe } from "@/lib/auth";
import { setWatching } from "@/lib/tasks";
import { body, route } from "@/lib/http";

/** POST { on } -> { watching, watchers } */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  return Response.json(await setWatching(me, (await ctx.params).id, (await body<{ on?: boolean }>(req)).on !== false));
}

export const POST = route(POST_);
