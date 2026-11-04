import { db } from "@/lib/db";
import { sendPlatformEmail } from "@/lib/platform-email";
import { requireUser, requireProject, projectAccess } from "@/lib/workspace";
import { route } from "@/lib/route";
import { notify, projectAdmins, ROLE_FOR } from "@/lib/sharing";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Ask for access. "view" comes from someone who can't open the project at
 * all; "edit" from a viewer. Only the project's existence is revealed.
 */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.deletedAt) return Response.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json()) as { kind?: string; message?: string };
  const kind = body.kind === "edit" ? "edit" : "view";
  const access = await projectAccess(user.id, project);
  if (access === "admin" || access === "edit" || (kind === "view" && access === "view")) {
    return Response.json({ error: "You already have that access." }, { status: 409 });
  }
  const pending = await db.accessRequest.findFirst({ where: { projectId: id, userId: user.id, status: "PENDING" } });
  if (pending) return Response.json({ ok: true, id: pending.id, alreadyRequested: true });

  const r = await db.accessRequest.create({
    data: { projectId: id, userId: user.id, kind, message: body.message?.trim().slice(0, 500) || null },
  });
  await notify(await projectAdmins(project), {
    projectId: id,
    kind: "access_request",
    title: `${user.name ?? user.email ?? "Someone"} asked to ${kind === "edit" ? "edit" : "view"} ${project.name}`,
    body: r.message ?? undefined,
    href: `/projects/${id}?share=1`,
  });
  return Response.json({ ok: true, id: r.id }, { status: 201 });
}

/** Approve or decline one request, or decline every pending one. */
async function PATCH_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "admin");
  const body = (await req.json()) as { requestId?: string; decision?: "approve" | "decline"; declineAll?: boolean };

  const targets = body.declineAll
    ? await db.accessRequest.findMany({ where: { projectId: id, status: "PENDING" } })
    : await db.accessRequest.findMany({ where: { id: body.requestId ?? "", projectId: id, status: "PENDING" } });
  if (!targets.length) return Response.json({ error: "Not found" }, { status: 404 });
  const approve = !body.declineAll && body.decision === "approve";

  for (const r of targets) {
    await db.accessRequest.update({
      where: { id: r.id },
      data: { status: approve ? "APPROVED" : "DECLINED", decidedAt: new Date(), decidedById: user.id },
    });
    if (approve) {
      const role = ROLE_FOR[r.kind === "edit" ? "edit" : "view"];
      await db.collaborator.upsert({
        where: { projectId_userId: { projectId: id, userId: r.userId } },
        create: { projectId: id, userId: r.userId, role },
        update: { role },
      });
    }
    await notify([r.userId], {
      projectId: id,
      kind: approve ? "access_approved" : "access_declined",
      title: approve
        ? `You can now ${r.kind === "edit" ? "edit" : "view"} ${project.name}`
        : `Your request for ${project.name} was declined`,
      href: approve ? `/projects/${id}` : undefined,
    });
    // And by email, so they hear back even when they aren't in Forge.
    const to = await db.user.findUnique({ where: { id: r.userId }, select: { email: true } });
    if (to?.email) {
      await sendPlatformEmail({
        to: to.email,
        subject: approve ? `You can now ${r.kind === "edit" ? "edit" : "view"} ${project.name}` : `Your request for ${project.name} was declined`,
        text: approve
          ? `Your request was approved. Open the project: ${process.env.EDITOR_ORIGIN ?? "http://localhost:3000"}/projects/${id}`
          : `Your request to access ${project.name} was declined. You can ask the project's owner directly.`,
      }).catch(() => undefined);
    }
  }
  return Response.json({ ok: true, count: targets.length });
}

export const POST = route(POST_);
export const PATCH = route(PATCH_);
