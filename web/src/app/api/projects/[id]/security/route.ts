import { requireProjectPerm } from "@/lib/iotx/permissions";
import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { ensureWorker } from "@/lib/worker";
import { checksCatalog, fixPrompt, getConfig, runScan, setConfig } from "@/lib/security";
import { CHECKS } from "@/lib/scan";
import { route } from "@/lib/route";
import { DeepScanError, deepScan } from "@/lib/deep-scan";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Everything the security center shows. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const config = await getConfig(id);
  const findings = await db.securityFinding.findMany({
    where: { projectId: id },
    orderBy: [{ ignored: "asc" }, { createdAt: "desc" }],
  });
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 } as const;
  findings.sort((a, b) => Number(a.ignored) - Number(b.ignored) || rank[a.severity] - rank[b.severity]);
  return Response.json({
    checks: checksCatalog(config.disabled),
    findings: findings.map((f) => ({
      ...f,
      // Deep-scan findings carry their own title as the first sentence.
      title: f.rule.startsWith("deep:") ? f.detail.split(". ")[0] : (CHECKS.find((c) => c.id === f.rule)?.title ?? f.rule),
      category: f.rule.startsWith("deep:") ? "AI deep scan" : (CHECKS.find((c) => c.id === f.rule)?.category ?? "Other"),
    })),
    deepScan: config.deepScan ?? null,
    audit: config.audit ?? null,
    memory: config.memory ?? "",
    lastScanAt: config.lastScanAt ?? null,
  });
}

/**
 * Actions: scan · deep-scan (AI review, costs credits) · ignore {findingId, reason} · unignore {findingId} ·
 * toggle {checkId, enabled} · memory {text} · fix {findingIds}
 */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    findingId?: string;
    findingIds?: string[];
    reason?: string;
    checkId?: string;
    enabled?: boolean;
    text?: string;
  };

  switch (body.action) {
    case "scan":
      return Response.json({ ok: true, ...(await runScan(id)) });

    case "deep-scan":
      try {
        return Response.json({ ok: true, deepScan: await deepScan(id, user.id) });
      } catch (e) {
        if (e instanceof DeepScanError) return Response.json({ error: e.message }, { status: 409 });
        throw e;
      }

    case "ignore": {
      await requireProjectPerm(user.id, id, "builder.security.override");
      if (!body.findingId || !body.reason?.trim()) {
        return Response.json({ error: "A reason is required to ignore a finding." }, { status: 400 });
      }
      await db.securityFinding.updateMany({
        where: { id: body.findingId, projectId: id },
        data: { ignored: true, ignoreReason: body.reason.trim().slice(0, 300) },
      });
      return Response.json({ ok: true });
    }

    case "unignore":
      await db.securityFinding.updateMany({
        where: { id: body.findingId, projectId: id },
        data: { ignored: false, ignoreReason: null },
      });
      return Response.json({ ok: true });

    case "toggle": {
      if (!CHECKS.some((c) => c.id === body.checkId)) {
        return Response.json({ error: "Unknown check" }, { status: 400 });
      }
      const config = await getConfig(id);
      const disabled = new Set(config.disabled ?? []);
      if (body.enabled) disabled.delete(body.checkId!);
      else disabled.add(body.checkId!);
      await setConfig(id, { disabled: [...disabled] });
      return Response.json({ ok: true });
    }

    case "memory":
      await setConfig(id, { memory: (body.text ?? "").slice(0, 5000) });
      return Response.json({ ok: true });

    case "fix": {
      // The prompt is built here from real findings, so "free" can only ever
      // cover security work.
      const prompt = await fixPrompt(id, body.findingIds ?? []);
      if (!prompt) return Response.json({ error: "No open findings to fix." }, { status: 400 });
      const userMessage = await db.message.create({
        data: { projectId: id, userId: user.id, role: "USER", content: prompt, mode: "build" },
      });
      const reply = await db.message.create({
        data: { projectId: id, role: "ASSISTANT", content: "", mode: "build" },
      });
      const build = await db.build.create({
        data: { projectId: id, messageId: reply.id, status: "QUEUED", mode: "build", free: true },
      });
      ensureWorker();
      return Response.json({ ok: true, buildId: build.id, userMessageId: userMessage.id, messageId: reply.id, prompt });
    }

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
