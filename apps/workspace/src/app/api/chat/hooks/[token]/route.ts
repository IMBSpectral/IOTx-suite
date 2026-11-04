import { postViaHook } from "@/lib/chat";
import { body, route } from "@/lib/http";

/**
 * Incoming webhook (no sign-in; the secret is in the URL):
 * POST { text } -> { ok, id } and the message appears in the channel.
 */
async function POST_(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const b = await body<{ text?: string }>(req);
  if (!String(b.text ?? "").trim()) return Response.json({ error: 'Send JSON like { "text": "Hello" }.' }, { status: 400 });
  const m = await postViaHook((await ctx.params).token, String(b.text));
  return Response.json({ ok: true, id: m.id });
}

export const POST = route(POST_);
