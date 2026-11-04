import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { domainStatus } from "@/lib/domains";

type Ctx = { params: Promise<{ id: string }> };

/** The custom domain's live DNS status, polled by Project settings while it isn't connected. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "view");
  if (!project.customDomain) return Response.json({ domain: null });
  return Response.json(await domainStatus(project.customDomain));
}

export const GET = route(GET_);
