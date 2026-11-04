import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { CanvasError, readCanvas, saveCanvas } from "@/lib/canvas";

type Ctx = { params: Promise<{ id: string }> };

async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  if (project.kind !== "canvas") return Response.json({ error: "Not a canvas project" }, { status: 400 });
  return Response.json(await readCanvas(id));
}

/** Save the whole drawing (the editor debounces, so this is a few times a minute at most). */
async function PUT_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  if (project.kind !== "canvas") return Response.json({ error: "Not a canvas project" }, { status: 400 });
  try {
    const doc = await saveCanvas(id, await req.json().catch(() => null));
    return Response.json({ ok: true, shapes: doc.shapes.length });
  } catch (e) {
    if (e instanceof CanvasError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const PUT = route(PUT_);
