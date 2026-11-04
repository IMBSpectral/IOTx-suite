import { requireMe } from "@/lib/auth";
import { logWork } from "@/lib/tasks";
import { body, route } from "@/lib/http";

/** POST { time: "1h 30m" | minutes, note?, day? } -> { worklog } */
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("tasks.open");
  return Response.json({ worklog: await logWork(me, (await ctx.params).id, await body(req)) }, { status: 201 });
}

export const POST = route(POST_);
