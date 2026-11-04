import { db } from "@/lib/db";
import { requireUser, requireProject, currentWorkspace } from "@/lib/workspace";
import { requirePerm } from "@/lib/iotx/permissions";
import { forkRepo } from "@/lib/repo";
import { hostLabel, hostSafeId } from "@/lib/create-project";
import { route } from "@/lib/route";

/** Remix: copy the current tree into a new project, without the history. */
async function POST_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  const source = await requireProject(user.id, id, "edit");
  const ws = await currentWorkspace(user.id);
  await requirePerm(user.id, ws.id, "builder.project.create");

  const name = `${source.name} copy`.slice(0, 80);
  const base = hostLabel(name);

  const copy = await db.project.create({
    data: {
      workspaceId: ws.id,
      name,
      slug: `${base}-${hostSafeId(6)}`,
      subdomain: `${base}-${hostSafeId(8)}`,
      description: source.description,
    },
  });

  const sha = await forkRepo(id, copy.id);
  await db.project.update({ where: { id: copy.id }, data: { headSha: sha } });

  return Response.json({ project: copy }, { status: 201 });
}

export const POST = route(POST_);
