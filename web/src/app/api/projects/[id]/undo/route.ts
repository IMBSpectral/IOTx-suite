import { requireProjectPerm } from "@/lib/iotx/permissions";
import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { headSha, parentOf, restoreTree } from "@/lib/repo";
import { currentDraftId } from "@/lib/drafts";
import { route } from "@/lib/route";

/**
 * Undo the latest edit, or reapply an undone one.
 *
 * Only the change at the tip of the current branch can be undone — undoing an
 * older edit would also take out everything built on top of it. The undo is a
 * new commit restoring the previous tree, so "The undone changes stay in the
 * chat and can be reapplied".
 */
async function POST_(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.build");
  const { buildId, action } = (await req.json().catch(() => ({}))) as {
    buildId?: string;
    action?: "undo" | "redo";
  };

  const build = buildId
    ? await db.build.findFirst({ where: { id: buildId, projectId: id } })
    : null;
  if (!build?.sha) return Response.json({ error: "That turn made no changes." }, { status: 404 });
  if ((await db.build.count({ where: { projectId: id, status: { in: ["RUNNING", "QUEUED"] } } })) > 0) {
    return Response.json({ error: "Wait for the current turn to finish." }, { status: 409 });
  }

  try {
    let sha: string;
    if (action === "redo") {
      if (!build.undone) return Response.json({ error: "This edit is not undone." }, { status: 409 });
      sha = await restoreTree(id, build.sha, "Reapply edit");
    } else {
      if (build.undone) return Response.json({ error: "Already undone." }, { status: 409 });
      if ((await headSha(id)) !== build.sha) {
        return Response.json(
          { error: "Only the latest edit can be undone. Restore an older version from History instead." },
          { status: 409 },
        );
      }
      const parent = await parentOf(id, build.sha);
      if (!parent) return Response.json({ error: "Nothing before this edit." }, { status: 409 });
      sha = await restoreTree(id, parent, "Undo latest edit");
    }

    // The new commit is the tip of whichever branch is checked out.
    const draftId = await currentDraftId(id);
    await db.$transaction([
      db.build.update({ where: { id: build.id }, data: { undone: action !== "redo" } }),
      draftId
        ? db.draft.update({ where: { id: draftId }, data: { headSha: sha } })
        : db.project.update({ where: { id }, data: { headSha: sha } }),
    ]);
    return Response.json({ ok: true, sha, undone: action !== "redo" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Undo failed" }, { status: 500 });
  }
}

export const POST = route(POST_);
