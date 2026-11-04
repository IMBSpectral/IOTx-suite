import { requireMe } from "@/lib/auth";
import { loadProject } from "@/lib/tasks";
import { projectDto, updateProject } from "@/lib/tasks-plan";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { project } · PATCH { name?, key?, description?, color?, leadId?, statuses?, labelDefs?, members?: [{userId, role}], archived? } (project admins) */
async function GET_(_req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ project: await projectDto(await loadProject(me, (await ctx.params).id), me.userId) });
}
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json({ project: await updateProject(me, (await ctx.params).id, await body(req)) });
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
