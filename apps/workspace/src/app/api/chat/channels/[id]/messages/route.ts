import { requireMe } from "@/lib/auth";
import { listMessages, postMessage, scheduleMessage } from "@/lib/chat";
import { body, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET ?thread=<rootId> | ?before=ISO | ?after=ISO | ?around=<messageId>, &limit -> { messages, root?, more?, newer? }
 * POST { body, parentId?, mentions?, fileIds?, alsoChannel?, sharedId? } -> { message }  (delivered to others over SSE)
 * POST { ..., sendAt: ISO } -> { scheduled } posted at that time
 */
async function GET_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  const q = new URL(req.url).searchParams;
  const opt = (k: string) => q.get(k) ?? undefined;
  return Response.json(await listMessages(me, (await ctx.params).id, { thread: opt("thread"), before: opt("before"), after: opt("after"), around: opt("around"), limit: q.get("limit") ? Number(q.get("limit")) : undefined }));
}

async function POST_(req: Request, ctx: Ctx) {
  const me = await requireMe("teamchat.open");
  const b = await body<{ body?: string; parentId?: string; mentions?: string[]; fileIds?: string[]; alsoChannel?: boolean; sharedId?: string; sendAt?: string }>(req);
  const id = (await ctx.params).id;
  if (b.sendAt) return Response.json({ scheduled: await scheduleMessage(me, id, b) }, { status: 201 });
  return Response.json({ message: await postMessage(me, id, b) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
