import fs from "node:fs/promises";
import path from "node:path";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { PROJECTS_ROOT } from "@/lib/paths";

/**
 * Project notes: free-form Markdown for the people working on the project
 * ("Write notes for this project..."). Kept beside the repo, not in the app's
 * code, and not sent to the agent (that's what Knowledge is for).
 */
type Ctx = { params: Promise<{ id: string }> };
const file = (projectId: string) => path.join(PROJECTS_ROOT, "_notes", `${projectId}.md`);

async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const stat = await fs.stat(file(id)).catch(() => null);
  const text = stat ? await fs.readFile(file(id), "utf8") : "";
  return Response.json({ text, updatedAt: stat?.mtime.toISOString() ?? null });
}

async function PUT_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const { text } = (await req.json().catch(() => ({}))) as { text?: unknown };
  if (typeof text !== "string") return Response.json({ error: "Send the notes as text." }, { status: 400 });
  if (text.length > 100_000) return Response.json({ error: "Notes can be up to 100,000 characters." }, { status: 400 });
  await fs.mkdir(path.dirname(file(id)), { recursive: true });
  await fs.writeFile(file(id), text);
  return Response.json({ ok: true, updatedAt: new Date().toISOString() });
}

export const GET = route(GET_);
export const PUT = route(PUT_);
