import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { readAnnouncements } from "@/lib/engagement";
import { deleteAnnouncement, saveAnnouncement, workspaceAnnouncementsFile } from "@/lib/announcement-api";

/** The workspace's own banners for its members (owners and admins manage them). */
async function admin() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  return workspaceAnnouncementsFile(ws.id);
}

async function GET_() {
  return Response.json({ announcements: await readAnnouncements(await admin()) });
}

async function POST_(req: Request) {
  const file = await admin();
  return saveAnnouncement((await req.json().catch(() => ({}))) as Record<string, unknown>, file);
}

async function DELETE_(req: Request) {
  return deleteAnnouncement(req, await admin());
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
