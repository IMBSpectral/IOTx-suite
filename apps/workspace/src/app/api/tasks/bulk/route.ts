import { requireMe } from "@/lib/auth";
import { bulkUpdate, type TaskInput } from "@/lib/tasks";
import { body, route } from "@/lib/http";

/** POST { ids, patch: TaskInput, delete?: true } -> { results, updated } (each issue checked like a single edit) */
async function POST_(req: Request) {
  const me = await requireMe("tasks.open");
  const b = await body<{ ids?: string[]; patch?: TaskInput; delete?: boolean }>(req);
  return Response.json(await bulkUpdate(me, Array.isArray(b.ids) ? b.ids.map(String) : [], { ...(b.patch ?? {}), delete: b.delete === true }));
}

export const POST = route(POST_);
