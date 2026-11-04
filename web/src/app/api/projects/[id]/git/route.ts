import { requireProjectPerm } from "@/lib/iotx/permissions";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { branches, cleanHistory, deleteBranch, GitMaintenanceError, largeFiles } from "@/lib/git-maintenance";

type Ctx = { params: Promise<{ id: string }> };

/** Branches, and (?large=1) large files in history. */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  if (new URL(req.url).searchParams.get("large") === "1") return Response.json({ files: await largeFiles(id) });
  return Response.json({ branches: await branches(id), projectName: project.name });
}

/** deleteBranch {name} · cleanHistory {confirm: project name} (project admins only) */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "admin");
  await requireProjectPerm(user.id, id, "builder.code.edit");
  const b = (await req.json().catch(() => ({}))) as { action?: string; name?: string; confirm?: string };
  try {
    if (b.action === "deleteBranch") {
      await deleteBranch(id, b.name ?? "");
      return Response.json({ ok: true });
    }
    if (b.action === "cleanHistory") return Response.json(await cleanHistory(id, b.confirm ?? ""));
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    if (e instanceof GitMaintenanceError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
