import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { ensureWorker } from "@/lib/worker";
import { ensureMonitor, getMonitoring, runHealth, setMonitoring } from "@/lib/monitoring";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/** Monitoring settings, the latest brief and run history. */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  ensureMonitor();
  const m = await getMonitoring(id);
  const latest = m.runs[0] ?? null;
  // Only fixes still queued or running count; a removed or finished build doesn't.
  const live = await db.build.findMany({
    where: { id: { in: Object.values(m.fixing) }, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true },
  });
  const liveIds = new Set(live.map((b) => b.id));
  return Response.json({
    on: m.on,
    frequency: m.frequency,
    ignored: m.ignored,
    fixing: Object.entries(m.fixing)
      .filter(([, buildId]) => liveIds.has(buildId))
      .map(([key]) => key),
    latest,
    open: latest ? latest.findings.filter((f) => !m.ignored.includes(f.key)) : [],
    history: m.runs.map((r) => ({ at: r.at, trigger: r.trigger, count: r.findings.length, error: r.error ?? null })),
  });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const body = (await req.json()) as { action?: string; on?: boolean; frequency?: string; key?: string; keys?: string[] };
  const m = await getMonitoring(id);

  switch (body.action) {
    case "configure":
      await setMonitoring(id, {
        on: body.on ?? m.on,
        frequency: body.frequency === "weekly" ? "weekly" : body.frequency === "daily" ? "daily" : m.frequency,
      });
      ensureMonitor();
      return Response.json({ ok: true });
    case "run":
    case "seo": {
      const run = await runHealth(id, body.action === "seo" ? "seo" : "manual");
      return Response.json({ ok: true, run });
    }
    case "ignore":
    case "unignore": {
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 });
      const ignored = new Set(m.ignored);
      if (body.action === "ignore") ignored.add(body.key);
      else ignored.delete(body.key);
      await setMonitoring(id, { ignored: [...ignored] });
      return Response.json({ ok: true });
    }
    case "fix": {
      const latest = m.runs[0];
      const wanted = (body.keys ?? []).filter((k) => !m.ignored.includes(k));
      const findings = latest?.findings.filter((f) => wanted.includes(f.key)) ?? [];
      if (!findings.length) return Response.json({ error: "Nothing to fix." }, { status: 400 });
      // Dedupe: a finding whose fix is still queued or running isn't sent twice.
      for (const f of findings) {
        const buildId = m.fixing[f.key];
        if (!buildId) continue;
        const b = await db.build.findUnique({ where: { id: buildId }, select: { status: true } });
        if (b && (b.status === "QUEUED" || b.status === "RUNNING")) {
          return Response.json({ error: "This issue is already being fixed.", key: f.key }, { status: 409 });
        }
      }
      const prompt =
        findings.length === 1
          ? findings[0].fix
          : `Fix these issues found by project monitoring:\n\n${findings.map((f, i) => `${i + 1}. [${f.category}] ${f.title}: ${f.fix}`).join("\n")}`;
      const userMessage = await db.message.create({
        data: { projectId: id, userId: user.id, role: "USER", content: prompt, mode: "build" },
      });
      const reply = await db.message.create({ data: { projectId: id, role: "ASSISTANT", content: "", mode: "build" } });
      const build = await db.build.create({ data: { projectId: id, messageId: reply.id, status: "QUEUED", mode: "build" } });
      await setMonitoring(id, { fixing: { ...m.fixing, ...Object.fromEntries(findings.map((f) => [f.key, build.id])) } });
      ensureWorker();
      return Response.json({ ok: true, buildId: build.id, userMessageId: userMessage.id, messageId: reply.id, prompt });
    }
    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
