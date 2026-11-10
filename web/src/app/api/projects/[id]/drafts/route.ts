import { requireUser, requireProject } from "@/lib/workspace";
import { listDrafts, acceptBlockedReason, currentDraftId, markDraftSeen, draftBehind } from "@/lib/drafts";
import { route } from "@/lib/route";
import { getCloud } from "@/lib/cloud";

/** Open drafts for a project, each with the reason it cannot be accepted. */
async function GET_(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);

  // Whatever the preview is showing counts as seen by whoever is looking.
  const current = await currentDraftId(id);
  if (current) await markDraftSeen(current, user.id);
  const drafts = await listDrafts(id);
  const behind = await Promise.all(drafts.map((d) => draftBehind(id, d)));
  const cloud = !!(await getCloud(id))?.enabled;
  return Response.json({
    current,
    cloud,
    review: !!project.reviewDrafts,
    drafts: drafts.map((d, i) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      headSha: d.headSha,
      createdAt: d.createdAt,
      mergedAt: d.mergedAt,
      unseen: !d.seenBy.includes(user.id),
      ownBackend: d.ownBackend,
      behind: behind[i],
      acceptBlockedReason:
        acceptBlockedReason(d) ?? (behind[i] ? "Update the draft to catch up with the project before accepting." : null),
    })),
  });
}

export const GET = route(GET_);
