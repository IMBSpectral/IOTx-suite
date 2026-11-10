import { promises as fs } from "node:fs";
import { analysisFor, insightsRoute } from "@/lib/insights/http";
import { addFile } from "@/lib/insights/ingest";
import { docFile, InsightsError, saveAnalysis, sourceFile, withLock } from "@/lib/insights/store";
import { dropTable } from "@/lib/insights/engine";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 300;

/** POST multipart files[] -> { analysis, added, errors } · DELETE ?source=<id> */
export const POST = insightsRoute(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await analysisFor(id, "insights.upload");
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string").slice(0, 20);
  if (!files.length) return Response.json({ error: "No files" }, { status: 400 });
  const errors: string[] = [];
  const added: string[] = [];
  const a = await withLock(id, async () => {
    const { a } = await analysisFor(id, "insights.upload");
    for (const f of files) {
      try {
        const s = await addFile(a, f.name, Buffer.from(await f.arrayBuffer()));
        added.push(s.id);
      } catch (e) {
        console.error("[insights] add file", f.name, e);
        errors.push(e instanceof InsightsError ? e.message : `${f.name} couldn't be read.`);
      }
    }
    return saveAnalysis(a);
  });
  return Response.json({ analysis: a, added, errors });
});

export const DELETE = insightsRoute(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const sid = new URL(req.url).searchParams.get("source") ?? "";
  await analysisFor(id, "insights.upload");
  const a = await withLock(id, async () => {
    const { a } = await analysisFor(id, "insights.upload");
    const s = a.sources.find((x) => x.id === sid);
    if (!s) return a;
    for (const t of s.tables) await dropTable(a, t);
    a.tables = a.tables.filter((t) => !s.tables.includes(t.name));
    a.sources = a.sources.filter((x) => x.id !== sid);
    await fs.rm(sourceFile(a, s), { force: true });
    await fs.rm(docFile(a, s.id), { force: true });
    return saveAnalysis(a);
  });
  return Response.json({ analysis: a });
});
