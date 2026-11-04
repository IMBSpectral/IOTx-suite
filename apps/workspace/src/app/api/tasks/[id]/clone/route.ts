import { requireMe } from "@/lib/auth";
import { cloneTask } from "@/lib/tasks";
import { route } from "@/lib/http";

/** POST -> { task }: a copy with its subtasks, linked as "clones" */
async function POST_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(["tasks.open", "tasks.create"]);
  return Response.json({ task: await cloneTask(me, (await ctx.params).id) }, { status: 201 });
}

export const POST = route(POST_);
