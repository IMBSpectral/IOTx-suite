import { requireMe } from "@/lib/auth";
import { deleteVersion, listVersions, releaseNotes, releaseVersion, saveVersion } from "@/lib/tasks-board";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> { versions } with progress · GET ?notes=<id> -> { notes } · POST { id?, name, description, startDate, releaseDate, status } · POST { action: "release", id, moveTo } · DELETE ?id= */
async function GET_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  const id = (await ctx.params).id;
  const notes = new URL(req.url).searchParams.get("notes");
  if (notes) return Response.json({ notes: await releaseNotes(me, id, notes) });
  return Response.json({ versions: await listVersions(me, id) });
}
async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  const id = (await ctx.params).id;
  const b = await body<Record<string, unknown>>(req);
  if (b.action === "release") return Response.json(await releaseVersion(me, id, String(b.id ?? ""), typeof b.moveTo === "string" && b.moveTo ? b.moveTo : null));
  return Response.json({ version: await saveVersion(me, id, b) }, { status: 201 });
}
async function DELETE_(req: Request, ctx: Ctx) {
  const me = await requireMe("tasks.open");
  return Response.json(await deleteVersion(me, (await ctx.params).id, new URL(req.url).searchParams.get("id") ?? ""));
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
