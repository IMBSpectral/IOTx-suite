import { analysisFor, insightsRoute } from "@/lib/insights/http";
import { runAgent } from "@/lib/insights/agent";
import { InsufficientCredits, SpendLimitReached } from "@/lib/credits";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 800;

const running = new Set<string>();

/** POST { text } -> application/x-ndjson: text, thought, step, board, tables, questions, name, then done or error. */
export const POST = insightsRoute(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { v, a } = await analysisFor(id, "insights.ai");
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = body.text?.trim().slice(0, 8000);
  if (!text) return Response.json({ error: "Message is empty" }, { status: 400 });
  if (running.has(a.id)) return Response.json({ error: "The analyst is still working on the last message." }, { status: 409 });
  running.add(a.id);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      let open = true;
      const send = (e: object) => {
        if (!open) return;
        try {
          c.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false;
        }
      };
      try {
        const r = await runAgent(a, v.userId, text, send);
        send({ type: "done", reply: r.reply, questions: r.questions, steps: r.steps });
      } catch (e) {
        console.error("[insights] chat", e);
        send({
          type: "error",
          error: e instanceof InsufficientCredits || e instanceof SpendLimitReached ? "You're out of credits or at a spending limit." : "Something went wrong. Try again.",
        });
      } finally {
        running.delete(a.id);
        if (open) {
          try {
            c.close();
          } catch {}
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
