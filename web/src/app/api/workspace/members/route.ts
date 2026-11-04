import { db } from "@/lib/db";
import { assertSeat, MembersError } from "@/lib/members-extra";
import { audit, inviteAllowed } from "@/lib/workspace-security";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import type { Role } from "@prisma/client";
import { route } from "@/lib/route";

async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);

  const members = await db.membership.findMany({
    where: { workspaceId: ws.id },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: "asc" },
  });

  return Response.json({
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
    })),
  });
}

/**
 * Invite by email. A user who has never signed in has no row yet, so the
 * membership is created against a placeholder user that the OAuth callback
 * later adopts by matching email.
 */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);

  const { email, role } = (await req.json()) as { email?: string; role?: Role };
  const address = email?.trim().toLowerCase();
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return Response.json({ error: "A valid email is required" }, { status: 400 });
  }

  const wsFull = await db.workspace.findUniqueOrThrow({ where: { id: ws.id } });
  if (!inviteAllowed(wsFull, address)) {
    return Response.json({ error: "Only verified-domain emails can be invited." }, { status: 403 });
  }

  const invitee = await db.user.upsert({
    where: { email: address },
    update: {},
    create: { email: address },
  });

  const existing = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: invitee.id, workspaceId: ws.id } },
  });
  if (existing) {
    return Response.json({ error: "Already a member" }, { status: 409 });
  }

  try {
    await assertSeat(ws.id);
  } catch (e) {
    if (e instanceof MembersError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
  await db.membership.create({
    data: {
      userId: invitee.id,
      workspaceId: ws.id,
      role: role === "ADMIN" || role === "VIEWER" ? role : "MEMBER",
    },
  });
  await audit(ws.id, user.id, "member.invited", `Invited ${address} as ${role === "ADMIN" || role === "VIEWER" ? role.toLowerCase() : "member"}`);

  return Response.json({ ok: true }, { status: 201 });
}

async function DELETE_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);

  const { membershipId } = (await req.json()) as { membershipId?: string };
  if (!membershipId) {
    return Response.json({ error: "membershipId is required" }, { status: 400 });
  }

  const target = await db.membership.findUnique({ where: { id: membershipId } });
  if (!target || target.workspaceId !== ws.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (target.role === "OWNER") {
    return Response.json({ error: "The owner cannot be removed" }, { status: 400 });
  }

  await db.membership.delete({ where: { id: membershipId } });
  const gone = await db.user.findUnique({ where: { id: target.userId }, select: { email: true } });
  await audit(ws.id, user.id, "member.removed", `Removed ${gone?.email ?? "a member"}`);
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const DELETE = route(DELETE_);
