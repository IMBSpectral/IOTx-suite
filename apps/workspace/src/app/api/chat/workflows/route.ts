import { requireMe } from "@/lib/auth";
import { createWorkflow, listWorkflows } from "@/lib/chat-apps";
import { body, route } from "@/lib/http";

/**
 * GET              -> { workflows } I built (admins: all)
 * GET ?channelId=  -> { workflows } shortcuts anyone can run in that channel
 * POST { name, trigger, steps, enabled? } -> the workflow
 */
async function GET_(req: Request) {
  const me = await requireMe("teamchat.open");
  const channelId = new URL(req.url).searchParams.get("channelId") ?? undefined;
  return Response.json({ workflows: await listWorkflows(me, { channelId }) });
}
async function POST_(req: Request) {
  const me = await requireMe("teamchat.open");
  return Response.json({ workflow: await createWorkflow(me, await body(req)) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
