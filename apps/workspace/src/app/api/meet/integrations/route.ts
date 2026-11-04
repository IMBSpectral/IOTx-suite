import { requireMe } from "@/lib/auth";
import { body, route } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import { getIntegrations, saveIntegrations } from "@/lib/meet/integrations";

export const dynamic = "force-dynamic";

/**
 * Meet → Integrations ("report ready → elsewhere"), mine.
 * GET -> { settings, workspaceRecap, webhooks, deliveries }
 * PUT { chatChannelId?, tasksProjectId?, kbSuggest?, calendarWriteback?, emailRecap?: off|workspace|attendees|invitees|me } -> same
 */
async function GET_() {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await getIntegrations(me));
}
async function PUT_(req: Request) {
  const me = await requireMe(MEET_KEYS.open);
  return Response.json(await saveIntegrations(me, await body(req)));
}

export const GET = route(GET_);
export const PUT = route(PUT_);
