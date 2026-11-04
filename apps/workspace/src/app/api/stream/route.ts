import { requireMe } from "@/lib/auth";
import { bus, type BusEvent } from "@/lib/bus";
import { canSeeChannelEvent } from "@/lib/chat";
import { connected, disconnected } from "@/lib/presence";
import { route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET -> Server-Sent Events: my notifications and my workspace's chat events.
 * A comment heartbeat every 20s keeps reverse proxies from closing it.
 */
async function GET_(req: Request) {
  const me = await requireMe();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctl) {
      const send = (s: string) => {
        try {
          ctl.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      const onUser = (ev: BusEvent) => send(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      const onWs = async (ev: BusEvent) => {
        if (await canSeeChannelEvent(me, ev)) send(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      bus.on(`user:${me.userId}`, onUser);
      bus.on(`ws:${me.ws}`, onWs);
      const hb = setInterval(() => send(`: heartbeat ${Date.now()}\n\n`), 20_000);
      connected(me.ws, me.userId);
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        disconnected(me.ws, me.userId);
        clearInterval(hb);
        bus.off(`user:${me.userId}`, onUser);
        bus.off(`ws:${me.ws}`, onWs);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          ctl.close();
        } catch {}
      });
      send(`retry: 3000\nevent: hello\ndata: {"type":"hello"}\n\n`);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

export const GET = route(GET_);
