import { requireMe } from "@/lib/auth";
import { createTask, listTasks, queryFromParams, type TaskInput } from "@/lib/tasks";
import { body, route } from "@/lib/http";

/**
 * GET ?projectId= &mine=1 &text= &assignee= &type= &status= &priority= &label= &sprint= &epic= &due= &sort= … -> { tasks }
 * POST TaskInput (projectId, title, …; parentId for a subtask) -> { task }
 */
async function GET_(req: Request) {
  const me = await requireMe("tasks.open");
  return Response.json({ tasks: await listTasks(me, queryFromParams(new URL(req.url).searchParams)) });
}

async function POST_(req: Request) {
  const me = await requireMe(["tasks.open", "tasks.create"]);
  return Response.json({ task: await createTask(me, await body<TaskInput>(req)) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
