import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { previewRoutes } from "@/lib/route-preview";

export const maxDuration = 120;

/** How each page of the published app looks in link previews and search results. */
async function GET_(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  return Response.json({ routes: await previewRoutes(id) });
}

export const GET = route(GET_);
