import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";

type Ctx = { params: Promise<{ buildId: string }> };

/** One build's job log: every event in order, as readable lines (text deltas merged). */
async function GET_(_req: Request, { params }: Ctx) {
  const { buildId } = await params;
  const user = await requireUser();
  const build = await db.build.findUnique({ where: { id: buildId }, select: { projectId: true, status: true, startedAt: true, endedAt: true, error: true } });
  if (!build) return Response.json({ error: "Not found" }, { status: 404 });
  await requireProject(user.id, build.projectId, "view");
  const events = await db.buildEvent.findMany({ where: { buildId }, orderBy: { seq: "asc" }, take: 5000 });
  const start = events[0]?.at.getTime() ?? 0;
  const lines: { t: number; kind: string; text: string }[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const t = e.at.getTime() - start;
    let text: string;
    switch (e.type) {
      case "text": {
        // Narration arrives in small pieces; keep it as one line per burst.
        const last = lines.at(-1);
        if (last?.kind === "text") {
          last.text += String(p.delta ?? "");
          continue;
        }
        text = String(p.delta ?? "");
        break;
      }
      case "file":
        text = `${p.op ?? "write"} ${p.path ?? ""}`;
        break;
      case "tool":
        text = String(p.step ?? "").replace(/^call:.*/, (s) => {
          try {
            const c = JSON.parse(s.slice(5));
            return `tool ${c.t}${c.e ? " (failed)" : ""}`;
          } catch {
            return "tool";
          }
        });
        break;
      case "stage":
        text = String(p.text ?? p.stage ?? "");
        break;
      case "error":
        text = `error: ${p.message ?? ""}`;
        break;
      case "usage":
        text = `tokens in ${p.inputTokens ?? 0}, out ${p.outputTokens ?? 0}`;
        break;
      default:
        text = Object.keys(p).length ? JSON.stringify(p).slice(0, 300) : "";
    }
    lines.push({ t, kind: e.type, text });
  }
  return Response.json({
    status: build.status,
    durationMs: build.startedAt && build.endedAt ? build.endedAt.getTime() - build.startedAt.getTime() : null,
    error: build.error,
    lines: lines.map((l) => ({ ...l, text: l.text.slice(0, 2000) })),
  });
}

export const GET = route(GET_);
