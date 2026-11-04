import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { can, requirePerm } from "@/lib/iotx/permissions";
import { addMailbox, detectProvider, isMailAdmin, MailError, mailboxesFor, publicMailbox, updateMailbox, type MailboxInput } from "@/lib/mail/mailbox";
import { PROVIDERS } from "@/lib/mail/providers";

/**
 * Mailbox management.
 *   GET -> { mine, canConnect, isAdmin, all?, members? }   (all/members only for mailbox admins)
 *   POST { action: "add", scope: "mine" | "shared" | "person", ownerId?, ...settings }
 *   POST { action: "update", id, ...settings }      owner or mailbox admin; re-tests before saving
 *   POST { action: "share", id, userIds }            mailbox admin; who uses a shared mailbox
 *   POST { action: "remove", id }                    owner or mailbox admin
 *   POST { action: "detect", email }                 -> { provider }
 */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const admin = await isMailAdmin(user.id, ws.id);
  const mine = (await mailboxesFor(user.id, ws.id)).map(publicMailbox);
  const out: Record<string, unknown> = { mine, canConnect: await can(user.id, ws.id, "mail.connect"), isAdmin: admin, providers: PROVIDERS };
  if (admin) {
    const [all, members] = await Promise.all([
      db.mailbox.findMany({ where: { workspaceId: ws.id }, orderBy: [{ ownerId: "asc" }, { email: "asc" }] }),
      db.membership.findMany({ where: { workspaceId: ws.id }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } }),
    ]);
    out.all = all.map(publicMailbox);
    out.members = members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email }));
  }
  return Response.json(out);
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const body = (await req.json().catch(() => ({}))) as MailboxInput & { action?: string; scope?: string; ownerId?: string; id?: string; userIds?: string[] };
  const admin = await isMailAdmin(user.id, ws.id);
  const fail = (msg: string, status = 400) => Response.json({ error: msg }, { status });

  try {
    switch (body.action) {
      case "detect":
        return Response.json({ provider: await detectProvider(String(body.email ?? "")) });

      case "add": {
        let ownerId: string | null;
        if (body.scope === "mine") {
          await requirePerm(user.id, ws.id, "mail.connect");
          ownerId = user.id;
        } else {
          if (!admin) return fail("Only mailbox admins can add mailboxes for others.", 403);
          if (body.scope === "person") {
            const member = body.ownerId && (await db.membership.findUnique({ where: { userId_workspaceId: { userId: body.ownerId, workspaceId: ws.id } } }));
            if (!member) return fail("Choose someone in this workspace.");
            ownerId = body.ownerId!;
          } else ownerId = null;
        }
        const m = await addMailbox(ws.id, user.id, ownerId, body);
        return Response.json({ mailbox: publicMailbox(m) }, { status: 201 });
      }

      case "update":
      case "remove":
      case "share": {
        const m = body.id ? await db.mailbox.findFirst({ where: { id: body.id, workspaceId: ws.id } }) : null;
        if (!m) return fail("Mailbox not found", 404);
        const owner = m.ownerId === user.id;
        if (!owner && !admin) return fail("Only its owner or a mailbox admin can change this mailbox.", 403);
        if (body.action === "remove") {
          await db.mailbox.delete({ where: { id: m.id } });
          return Response.json({ ok: true });
        }
        if (body.action === "share") {
          if (!admin) return fail("Only mailbox admins can assign shared mailboxes.", 403);
          if (m.ownerId) return fail("Personal mailboxes can't be shared.");
          const ids = [...new Set((body.userIds ?? []).map(String))];
          const valid = await db.membership.findMany({ where: { workspaceId: ws.id, userId: { in: ids } }, select: { userId: true } });
          const updated = await db.mailbox.update({ where: { id: m.id }, data: { sharedWith: valid.map((v) => v.userId) } });
          return Response.json({ mailbox: publicMailbox(updated) });
        }
        return Response.json({ mailbox: publicMailbox(await updateMailbox(m, body)) });
      }
      default:
        return fail("Unknown action");
    }
  } catch (e) {
    if (e instanceof MailError) return fail(e.message);
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
