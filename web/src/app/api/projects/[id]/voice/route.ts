import { db } from "@/lib/db";
import { getBrand } from "@/lib/brand";
import { requireUser, requireProject } from "@/lib/workspace";
import { refreshCredits } from "@/lib/billing-cycle";
import { route } from "@/lib/route";
import { addVoiceSeconds, createVoiceSession, VOICE_DAILY_SECONDS, VoiceError, voiceUsedToday } from "@/lib/voice";
import { consultProject } from "@/lib/kb";

type Ctx = { params: Promise<{ id: string }> };

/** Time left today. */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const used = await voiceUsedToday(user.id);
  return Response.json({ secondsLeft: Math.max(0, VOICE_DAILY_SECONDS - used), daily: VOICE_DAILY_SECONDS });
}

/**
 * start: mint a client secret for a new session.
 * kb { text }: the company knowledge for what was just said (before each reply) -> { context, hits }.
 * end: record the seconds spoken and save the transcript to the chat.
 */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  const body = (await req.json().catch(() => ({}))) as {
    action?: "start" | "end" | "kb";
    text?: string;
    seconds?: number;
    transcript?: { role: "user" | "assistant"; text: string }[];
  };
  try {
    if (body.action === "start") {
      // Calls need credits; the daily time limit applies on top of that.
      await refreshCredits(project.workspaceId);
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: project.workspaceId }, select: { creditBalance: true } });
      if (ws.creditBalance <= 0) {
        return Response.json({ error: "Voice calls need credits. Add credits to start a call.", upgrade: true }, { status: 402 });
      }
      return Response.json(await createVoiceSession({ userId: user.id, projectName: project.name }));
    }
    if (body.action === "kb") {
      const c = await consultProject(id, user.id, String(body.text ?? "").slice(0, 1000), { context: project.name, tool: true });
      return Response.json({ context: c.context, hits: c.hits.length });
    }
    if (body.action === "end") {
      const total = await addVoiceSeconds(user.id, Number(body.seconds) || 0);
      const lines = (body.transcript ?? []).filter((t) => t.text?.trim()).slice(0, 200);
      if (lines.length) {
        const text = lines.map((t) => `**${t.role === "user" ? "You" : getBrand().shortName}:** ${t.text.trim()}`).join("\n\n");
        // One message per call, so the chat keeps a readable record without a build.
        await db.message.create({
          data: { projectId: id, userId: user.id, role: "USER", content: `Voice call transcript\n\n${text}`.slice(0, 20_000), mode: "voice" },
        });
      }
      return Response.json({ ok: true, secondsLeft: Math.max(0, VOICE_DAILY_SECONDS - total) });
    }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof VoiceError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
