import { deleteDoc, getDoc, updateDoc } from "@/lib/kb";
import { kbRoute, kbViewer } from "@/lib/kb-http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { doc } · PATCH { title?, body?, kind?, tags?, audience?, roleIds?, status?, reviewEveryDays?, ownerId?, reviewed?, restore?, note? } · DELETE */
async function GET_(_req: Request, { params }: Ctx) {
  const v = await kbViewer();
  return Response.json({ doc: await getDoc(v, (await params).id) });
}
async function PATCH_(req: Request, { params }: Ctx) {
  const v = await kbViewer();
  return Response.json({ doc: await updateDoc(v, (await params).id, await req.json().catch(() => ({}))) });
}
async function DELETE_(_req: Request, { params }: Ctx) {
  const v = await kbViewer();
  return Response.json(await deleteDoc(v, (await params).id));
}

export const GET = kbRoute(GET_);
export const PATCH = kbRoute(PATCH_);
export const DELETE = kbRoute(DELETE_);
