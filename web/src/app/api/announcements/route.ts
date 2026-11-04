import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { activeAnnouncements, readAnnouncements } from "@/lib/engagement";
import { workspaceAnnouncementsFile } from "@/lib/announcement-api";

/** Current announcements: the workspace's own first, then Forge-wide ones. Dismissals are remembered per browser. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const own = activeAnnouncements(await readAnnouncements(workspaceAnnouncementsFile(ws.id))).map((a) => ({ ...a, scope: "workspace" as const }));
  return Response.json({ announcements: [...own, ...activeAnnouncements(await readAnnouncements())].slice(0, 3) });
}

export const GET = route(GET_);
