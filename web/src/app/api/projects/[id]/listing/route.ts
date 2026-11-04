import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { ListingError, removeListing, saveListing } from "@/lib/listing";

type Ctx = { params: Promise<{ id: string }> };

/** Create or edit the template's gallery listing. */
async function PUT_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  try {
    return Response.json({ listing: await saveListing(id, await req.json().catch(() => ({}))) });
  } catch (e) {
    if (e instanceof ListingError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** Remove the listing (and the project from the gallery). */
async function DELETE_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await removeListing(id);
  return Response.json({ ok: true });
}

export const PUT = route(PUT_);
export const DELETE = route(DELETE_);
