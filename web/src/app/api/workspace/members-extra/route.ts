import { db } from "@/lib/db";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import {
  createInviteLink,
  decideRole,
  deleteGroup,
  joinWithLink,
  memberProfile,
  membersExtra,
  MembersError,
  requestRole,
  revokeInviteLink,
  saveGroup,
  setSeatCap,
  shareWithGroup,
} from "@/lib/members-extra";

const ORIGIN = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";

/** Seat cap, groups, invite links and role requests (admins); ?profile=<userId> for a member profile (any member). */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const profile = new URL(req.url).searchParams.get("profile");
  try {
    if (profile) return Response.json(await memberProfile(ws.id, profile));
    const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } } });
    const data = await membersExtra(ws.id);
    if (m?.role !== "OWNER" && m?.role !== "ADMIN") {
      return Response.json({ role: m?.role, myRequest: data.roleRequests.find((r) => r.userId === user.id) ?? null, groups: data.groups.filter((g) => g.members.includes(user.id)) });
    }
    return Response.json({ ...data, role: m.role, linkBase: `${ORIGIN}/join/ws/` });
  } catch (e) {
    if (e instanceof MembersError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  try {
    if (b.action === "requestRole") return Response.json(await requestRole(ws.id, user.id, str("to"), str("reason")), { status: 201 });
    if (b.action === "join") return Response.json(await joinWithLink(str("token"), user.id));
    await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
    switch (b.action) {
      case "seatCap":
        await setSeatCap(ws.id, b.cap === null || b.cap === "" ? null : Number(b.cap));
        break;
      case "saveGroup":
        await saveGroup(ws.id, { id: str("id") || undefined, name: str("name"), members: Array.isArray(b.members) ? (b.members as string[]) : [] });
        break;
      case "deleteGroup":
        await deleteGroup(ws.id, str("id"));
        break;
      case "shareGroup":
        return Response.json(await shareWithGroup(ws.id, str("groupId"), str("projectId"), b.access === "edit" ? "edit" : "view"));
      case "createLink": {
        const l = await createInviteLink(ws.id, user.id, { role: str("role"), expiresInDays: Number(b.expiresInDays) || null, maxUses: Number(b.maxUses) || null });
        return Response.json({ ...l, url: `${ORIGIN}/join/ws/${l.token}` }, { status: 201 });
      }
      case "revokeLink":
        await revokeInviteLink(ws.id, str("token"));
        break;
      case "decideRole":
        await decideRole(ws.id, user.id, str("id"), b.approve === true);
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof MembersError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
