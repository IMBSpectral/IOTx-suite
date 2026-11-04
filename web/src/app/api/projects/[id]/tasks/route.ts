import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";

/** The agent's task list for the roadmap panel. */
async function GET_(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  return Response.json({ tasks: project.tasks ?? [] });
}

export const GET = route(GET_);
