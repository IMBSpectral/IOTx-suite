import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Company knowledge for this project's agent. GET -> { mode, tags } · POST { mode: "on" | "tags", tags? }
 * Every AI checks the knowledge base before acting, so there is no "off"; a stored "off" reads as "on".
 */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { kbMode: true, kbTags: true } });
  return Response.json(p.kbMode === "tags" && p.kbTags.length ? { mode: "tags", tags: p.kbTags } : { mode: "on", tags: [] });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  const b = (await req.json().catch(() => ({}))) as { mode?: string; tags?: unknown };
  if (b.mode === "off") return Response.json({ error: "Company knowledge can't be turned off: every AI checks it before acting. Limit it to some tags instead." }, { status: 400 });
  if (!["on", "tags"].includes(String(b.mode))) return Response.json({ error: "Choose all articles or chosen tags." }, { status: 400 });
  const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20) : [];
  if (b.mode === "tags" && !tags.length) return Response.json({ error: "Pick at least one tag." }, { status: 400 });
  const p = await db.project.update({ where: { id }, data: { kbMode: String(b.mode), kbTags: b.mode === "tags" ? tags : [] }, select: { kbMode: true, kbTags: true } });
  return Response.json({ mode: p.kbMode, tags: p.kbTags });
}

export const GET = route(GET_);
export const POST = route(POST_);
