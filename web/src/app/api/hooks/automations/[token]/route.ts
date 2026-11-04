import { db } from "@/lib/db";
import { route } from "@/lib/route";
import { runAutomation } from "@/lib/automations";

type Ctx = { params: Promise<{ token: string }> };

const MAX_BODY = 10_000;
const MIN_GAP_MS = 60_000;

/**
 * Webhook trigger for an automation. The secret token in the URL is the only
 * credential; the request body (up to 10 KB) reaches the agent as data.
 * One run a minute per automation; paused automations don't run.
 */
async function POST_(req: Request, { params }: Ctx) {
  const { token } = await params;
  if (!/^[\w-]{32}$/.test(token)) return Response.json({ error: "Not found" }, { status: 404 });
  const a = await db.automation.findFirst({ where: { webhookToken: token } });
  if (!a) return Response.json({ error: "Not found" }, { status: 404 });
  if (a.status !== "active") return Response.json({ error: "This automation is paused." }, { status: 409 });
  if (a.lastRunAt && Date.now() - a.lastRunAt.getTime() < MIN_GAP_MS) {
    return Response.json({ error: "Too many requests: one run a minute." }, { status: 429, headers: { "retry-after": "60" } });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "The body is over 10 KB." }, { status: 413 });
  const turn = await runAutomation(a.id, "webhook", raw);
  if (!turn) return Response.json({ error: "Paused: out of credits or at a spending limit." }, { status: 402 });
  return Response.json({ ok: true, buildId: turn.buildId }, { status: 202 });
}

export const POST = route(POST_);
