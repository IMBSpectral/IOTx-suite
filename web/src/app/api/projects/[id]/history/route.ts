import { requireUser, requireProject } from "@/lib/workspace";
import { history } from "@/lib/repo";
import { route } from "@/lib/route";
import { db } from "@/lib/db";

async function GET_(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  const commits = await history(id);
  // An accepted draft's merge commit carries a short summary of the draft.
  const merged = await db.draft.findMany({
    where: { projectId: id, status: "MERGED", mergeSha: { in: commits.map((c) => c.sha) } },
    select: { id: true, name: true, mergeSha: true, createdAt: true, mergedAt: true, _count: { select: { builds: true } } },
  });
  const bySha = new Map(merged.map((d) => [d.mergeSha, d]));
  return Response.json({
    commits: commits.map((c) => {
      const d = bySha.get(c.sha);
      return d
        ? {
            ...c,
            draft: {
              name: d.name,
              turns: d._count.builds,
              openFor: d.mergedAt ? d.mergedAt.getTime() - d.createdAt.getTime() : null,
            },
          }
        : c;
    }),
  });
}

export const GET = route(GET_);
