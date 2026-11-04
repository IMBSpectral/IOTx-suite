import { botChannel, botMe } from "@/lib/chat-apps";
import { listMessages, postMessage } from "@/lib/chat";
import { body, route } from "@/lib/http";

/**
 * The bot API (Authorization: Bearer xbot-…). The bot must be in the channel.
 * GET  ?channel=&thread=&before=&limit= -> { messages }
 * POST { channel, text, thread? } -> { message }
 */
async function GET_(req: Request) {
  const { me } = await botMe(req);
  const q = new URL(req.url).searchParams;
  const ch = await botChannel(me, q.get("channel") ?? "");
  return Response.json(await listMessages(me, ch.id, { thread: q.get("thread") ?? undefined, before: q.get("before") ?? undefined, limit: Number(q.get("limit") ?? 50) || 50 }));
}
async function POST_(req: Request) {
  const { me } = await botMe(req);
  const b = await body<{ channel?: string; text?: string; thread?: string }>(req);
  const ch = await botChannel(me, String(b.channel ?? ""));
  return Response.json({ message: await postMessage(me, ch.id, { body: String(b.text ?? ""), parentId: b.thread || undefined }) }, { status: 201 });
}

export const GET = route(GET_);
export const POST = route(POST_);
