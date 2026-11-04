import { requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { deleteWebhook, updateWebhook } from "@/lib/meet/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH { url?, active?, rotate? } -> { webhook, secret? } · DELETE -> { ok } */
async function PATCH_(req: Request, ctx: Ctx) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await updateWebhook(me, (await ctx.params).id, await body(req)));
}
async function DELETE_(_req: Request, ctx: Ctx) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await deleteWebhook(me, (await ctx.params).id));
}

export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
