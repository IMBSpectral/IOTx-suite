import { requireMe } from "@/lib/auth";
import { deleteWorkflow, runShortcut, updateWorkflow } from "@/lib/chat-apps";
import { body, route } from "@/lib/http";

/**
 * PATCH { name?, trigger?, steps?, enabled? } -> the workflow (its builder or an admin)
 * POST  { channelId, form } -> runs a shortcut workflow
 * DELETE
 */
async function PATCH_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  return Response.json({ workflow: await updateWorkflow(me, (await ctx.params).id, await body(req)) });
}
async function POST_(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  const b = await body<{ channelId?: string; form?: Record<string, unknown> }>(req);
  return Response.json(await runShortcut(me, (await ctx.params).id, String(b.channelId ?? ""), b.form ?? {}));
}
async function DELETE_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe("teamchat.open");
  return Response.json(await deleteWorkflow(me, (await ctx.params).id));
}

export const PATCH = route(PATCH_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
