import { requireUser, requireProject } from "@/lib/workspace";
import { siteAnalytics } from "@/lib/projects";
import { route } from "@/lib/route";

/** Daily page views of the published site over the last 30 days. */
async function GET_(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  return Response.json(await siteAnalytics(id, 30));
}

export const GET = route(GET_);
