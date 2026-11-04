import { requireUser, requireProject } from "@/lib/workspace";
import { appendLogs, clearLogs, readLogs, type RuntimeLog } from "@/lib/runtime-logs";
import { route } from "@/lib/route";

const LEVELS = new Set(["error", "warn"]);
const KINDS = new Set(["runtime", "console", "network", "resource"]);

/** The editor forwards what the preview's monitor captured. */
async function POST_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);

  const body = (await req.json().catch(() => null)) as { entries?: unknown[] } | null;
  const entries = (body?.entries ?? [])
    .slice(0, 100)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .filter((e) => LEVELS.has(String(e.level)) && KINDS.has(String(e.kind)))
    .map((e) => ({
      level: e.level as RuntimeLog["level"],
      kind: e.kind as RuntimeLog["kind"],
      message: String(e.message ?? "").slice(0, 2000),
      stack: e.stack ? String(e.stack).slice(0, 4000) : undefined,
      file: e.file ? String(e.file).slice(0, 300) : undefined,
      line: typeof e.line === "number" ? e.line : undefined,
      url: e.url ? String(e.url).slice(0, 300) : undefined,
      at: typeof e.at === "number" ? e.at : Date.now(),
    }));
  appendLogs(id, entries);
  return Response.json({ ok: true, stored: entries.length });
}

async function DELETE_(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  clearLogs(id);
  return Response.json({ ok: true });
}

async function GET_(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  return Response.json({ logs: readLogs(id, { limit: 100 }) });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
