import { requireMe } from "@/lib/auth";
import { route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { testWebhook } from "@/lib/meet/integrations";

export const dynamic = "force-dynamic";

/** POST -> { delivery } sends a signed report.test (my latest report, or a sample). */
async function POST_(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await testWebhook(me, (await ctx.params).id));
}

export const POST = route(POST_);
