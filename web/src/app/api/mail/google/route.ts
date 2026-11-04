import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { can } from "@/lib/iotx/permissions";
import { connectUrl, googleConfigured } from "@/lib/google";
import { GMAIL_SCOPES } from "@/lib/mail/gmail";

/**
 * Start "Sign in with Google" for a mailbox.
 *   GET ?scope=mine|shared|person&ownerId=&back=
 * Shared and colleague mailboxes need "Manage company mailboxes"; the admin
 * signs in to that mailbox's Google account on Google's screen.
 */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const q = new URL(req.url).searchParams;
  const rawBack = q.get("back") ?? "/mail";
  const back = rawBack.startsWith("/") && !rawBack.startsWith("//") ? rawBack : "/mail";
  const fail = (msg: string) => Response.redirect(new URL(`${back}${back.includes("?") ? "&" : "?"}mail_error=${encodeURIComponent(msg)}`, req.url), 303);
  if (!googleConfigured()) return fail("Google isn't set up on this server.");
  const scope = q.get("scope") === "shared" || q.get("scope") === "person" ? q.get("scope")! : "mine";
  let ownerId: string | null = user.id;
  if (scope === "mine") {
    if (!(await can(user.id, ws.id, "mail.connect"))) return fail("Connecting your own mailbox isn't turned on for your role.");
  } else {
    if (!(await can(user.id, ws.id, "admin.mailboxes"))) return fail("Only mailbox admins can connect mailboxes for others.");
    ownerId = null;
    if (scope === "person") {
      const id = q.get("ownerId") ?? "";
      const member = id && (await db.membership.findUnique({ where: { userId_workspaceId: { userId: id, workspaceId: ws.id } } }));
      if (!member) return fail("Choose someone in this workspace.");
      ownerId = id;
    }
  }
  return Response.redirect(
    connectUrl(user.id, user.email ?? null, back, { scopes: GMAIL_SCOPES, pickAccount: true, extra: { k: "mail", ws: ws.id, owner: ownerId } }),
    302,
  );
}

export const GET = route(GET_);
