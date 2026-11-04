import { getMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { byCode, control } from "@/lib/meet/meetings";

export const dynamic = "force-dynamic";

/**
 * POST { action, identity?, on?, lang? } (hosts and co-hosts):
 * "mute_all" | "mute" | "remove" | "lock" | "unlock" | "end" | "cohost" (host only) | "spotlight" | "captions"
 */
async function POST_(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const m = await byCode((await ctx.params).code);
  const b = await body<{ action?: string; identity?: string; on?: boolean; lang?: string }>(req);
  return Response.json(await control(await getMe(), m, b, req.headers.get("x-meet-guest")));
}

export const POST = route(POST_);
