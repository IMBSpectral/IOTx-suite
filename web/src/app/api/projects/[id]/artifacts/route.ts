import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { listArtifacts, readVisual } from "@/lib/visuals";

type Ctx = { params: Promise<{ id: string }> };

/** The project's artifacts (visual explanations and documents); ?id= returns one document's Markdown. */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  const one = new URL(req.url).searchParams.get("id");
  if (one) {
    const found = await readVisual(id, one);
    if (!found) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ artifact: found.visual, markdown: found.visual.kind === "doc" ? found.body : null });
  }
  return Response.json({ artifacts: await listArtifacts(id) });
}

export const GET = route(GET_);
