import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { readAnnouncements } from "@/lib/engagement";
import { deleteAnnouncement, saveAnnouncement } from "@/lib/announcement-api";
import { isPlatformAdmin } from "@/lib/platform-admin";

async function requireAdmin() {
  const user = await requireUser();
  if (!isPlatformAdmin(user.email))
    throw new Response("Forbidden", { status: 403 });
  return user;
}

/** Every announcement, past and scheduled included. */
async function GET_() {
  await requireAdmin();
  return Response.json({ announcements: await readAnnouncements() });
}

/** Create, or update one by id. */
async function POST_(req: Request) {
  await requireAdmin();
  return saveAnnouncement((await req.json().catch(() => ({}))) as Record<string, unknown>);
}

async function DELETE_(req: Request) {
  await requireAdmin();
  return deleteAnnouncement(req);
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
