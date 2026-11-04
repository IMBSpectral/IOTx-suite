import { requireMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { revokeToken } from "@/lib/meet/external";

export const dynamic = "force-dynamic";

/** DELETE -> { ok } revokes the token at once (the extension or MCP client is signed out). */
async function DELETE_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await revokeToken(me, (await ctx.params).id));
}

export const DELETE = route(DELETE_);
