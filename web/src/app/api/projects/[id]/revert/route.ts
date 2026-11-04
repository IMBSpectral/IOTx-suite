import { requireProjectPerm } from "@/lib/iotx/permissions";
import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { restoreTree, revertTo } from "@/lib/repo";
import { route } from "@/lib/route";

async function POST_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.build");

  const { sha, checkpoint } = (await req.json()) as { sha?: string; checkpoint?: boolean };
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
    return Response.json({ error: "A commit sha is required" }, { status: 400 });
  }

  // A checkpoint is a step inside an agent turn ("Restore to here").
  if (checkpoint) {
    if (await db.build.findFirst({ where: { projectId: id, status: { in: ["QUEUED", "RUNNING"] } } })) {
      return Response.json({ error: "Wait for the agent to finish, or stop it, before restoring." }, { status: 409 });
    }
    const head = await restoreTree(id, sha, `Restore to checkpoint ${sha.slice(0, 7)}`).catch(() => null);
    if (!head) return Response.json({ error: "That checkpoint isn't in this project." }, { status: 404 });
    await db.project.update({ where: { id }, data: { headSha: head, updatedAt: new Date() } });
    return Response.json({ ok: true, sha: head });
  }

  const head = await revertTo(id, sha);
  await db.project.update({
    where: { id },
    data: { headSha: head, updatedAt: new Date() },
  });
  return Response.json({ ok: true, sha: head });
}

export const POST = route(POST_);
