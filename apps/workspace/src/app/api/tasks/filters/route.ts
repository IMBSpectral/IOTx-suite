import { requireMe } from "@/lib/auth";
import { deleteFilter, listFilters, saveFilter } from "@/lib/tasks-plan";
import { body, route } from "@/lib/http";

/** GET -> { filters } (mine and shared) · POST { id?, name, query, shared? } · DELETE ?id= */
async function GET_() {
  const me = await requireMe("tasks.open");
  return Response.json({ filters: await listFilters(me) });
}
async function POST_(req: Request) {
  const me = await requireMe("tasks.open");
  return Response.json({ filter: await saveFilter(me, await body(req)) }, { status: 201 });
}
async function DELETE_(req: Request) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteFilter(me, new URL(req.url).searchParams.get("id") ?? ""));
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
