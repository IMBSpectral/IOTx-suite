import { requireMe } from "@/lib/auth";
import { createProject, defaultProject, listProjects } from "@/lib/tasks-plan";
import { body, route } from "@/lib/http";

/**
 * GET ?archived=1 -> { projects } I'm a member of (key, workflow, labels, members with roles, open count, running sprint)
 * POST { name, key?, color?, description?, memberIds? } -> a new project (needs tasks.project.create); I'm its admin.
 */
async function GET_(req: Request) {
  const me = await requireMe("tasks.open");
  // Every company has a "General" project everyone is in (made on first use).
  if (!me.guest) await defaultProject(me).catch(() => undefined);
  return Response.json({ projects: await listProjects(me, { archived: new URL(req.url).searchParams.get("archived") === "1" }) });
}

async function POST_(req: Request) {
  const me = await requireMe(["tasks.open", "tasks.project.create"]);
  return Response.json({ project: await createProject(me, await body(req)) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
