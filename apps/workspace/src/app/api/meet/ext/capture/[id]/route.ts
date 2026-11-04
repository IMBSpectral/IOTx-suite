import { body, route } from "@/lib/http";
import { captureStatus, discardCapture, tokenMe, updateCapture } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    (Bearer) -> { status, chunks, bytes, notesStatus, reportUrl, … }
 * PATCH  (Bearer) { title?, participants? } -> same (names seen on the call page)
 * DELETE (Bearer) -> { ok } throws the recording away
 */
async function GET_(req: Request, ctx: Ctx) {
  const { me } = await tokenMe(req);
  return Response.json(await captureStatus(me, (await ctx.params).id));
}
async function PATCH_(req: Request, ctx: Ctx) {
  const { me } = await tokenMe(req);
  return Response.json(await updateCapture(me, (await ctx.params).id, await body(req)));
}
async function DELETE_(req: Request, ctx: Ctx) {
  const { me } = await tokenMe(req);
  return Response.json(await discardCapture(me, (await ctx.params).id));
}

export const GET = route(GET_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
