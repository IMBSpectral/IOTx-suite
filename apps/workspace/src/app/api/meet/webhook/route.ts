import { route } from "@/lib/http";
import { webhookReceiver } from "@/lib/meet/livekit";
import { applyEgressInfo } from "@/lib/meet/recording";
import { applyStreamInfo } from "@/lib/meet/webinar";
import { handOver } from "@/lib/meet/meetings";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST from LiveKit (webhook in livekit.yaml), signed with the API key pair.
 * Keeps recording rows in step and starts AI notes when the audio file is done.
 */
async function POST_(req: Request) {
  const raw = await req.text();
  let ev;
  try {
    ev = await webhookReceiver().receive(raw, req.headers.get("authorization") ?? undefined);
  } catch {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  if (ev.egressInfo && ev.event.startsWith("egress_")) {
    await applyEgressInfo(ev.egressInfo);
    await applyStreamInfo(ev.egressInfo);
  }
  // Someone with host controls dropped out: hand them on so the waiting room isn't stuck.
  const id = /^meet_([a-z0-9]+)$/.exec(ev.room?.name ?? "")?.[1];
  if (ev.event === "participant_left" && id && ev.participant?.identity) {
    const m = await db.meeting.findUnique({ where: { id } });
    if (m && !m.endedAt) await handOver(m, ev.participant.identity).catch(() => null);
  }
  return Response.json({ ok: true });
}

export const POST = route(POST_);
