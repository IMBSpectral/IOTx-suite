import { requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { createWebhook, getIntegrations } from "@/lib/meet/integrations";

export const dynamic = "force-dynamic";

/**
 * GET -> { webhooks, deliveries }
 * POST { url } -> 201 { webhook, secret (shown once) }
 */
async function GET_() {
  const me = await requireMe(MEET_KEYS.open);
  const d = await getIntegrations(me);
  return Response.json({ webhooks: d.webhooks, deliveries: d.deliveries });
}
async function POST_(req: Request) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await createWebhook(me, await body(req)), { status: 201, headers: { "cache-control": "no-store" } });
}

export const GET = route(GET_);
export const POST = route(POST_);
