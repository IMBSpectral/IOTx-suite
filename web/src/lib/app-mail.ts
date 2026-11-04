import { db } from "./db";
import { sendMail } from "./mail/sync";

/**
 * Built apps can send their email (sign-in codes, notices, receipts) through
 * one of the company's own shared mailboxes, connected in Settings → Mailboxes:
 * Google mailboxes go over the Gmail API, others over SMTP. Email then comes
 * from the company's real address instead of a sending service.
 */

/** Shared mailboxes of the project's workspace that an app may send from. */
export async function appSenderOptions(projectId: string) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!p) return [];
  const boxes = await db.mailbox.findMany({
    where: { workspaceId: p.workspaceId, ownerId: null },
    select: { id: true, email: true, displayName: true, status: true, authType: true },
    orderBy: { email: "asc" },
  });
  return boxes;
}

/** Whether this mailbox may be chosen as the app's sender. */
export async function isAppSender(projectId: string, mailboxId: string) {
  return (await appSenderOptions(projectId)).some((b) => b.id === mailboxId);
}

/** Send one app email through the chosen mailbox. Throws with a readable reason. */
export async function sendFromAppMailbox(
  projectId: string,
  mailboxId: string,
  m: { to: string; subject: string; text: string; html: string | null; fromName?: string | null },
) {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  const box = p ? await db.mailbox.findFirst({ where: { id: mailboxId, workspaceId: p.workspaceId, ownerId: null } }) : null;
  if (!box) throw new Error("The mailbox this app sends from was disconnected. Choose another in Cloud → Email.");
  if (box.status === "error") throw new Error(`${box.email} can't sign in. An admin should reconnect it in Settings → Mailboxes.`);
  // The app's own sender name ("Inventory app") wins over the mailbox's display name.
  await sendMail({ ...box, displayName: m.fromName || box.displayName }, {
    to: [m.to],
    subject: m.subject,
    text: m.text || (m.html ?? "").replace(/<[^>]+>/g, " "),
    html: m.html ?? undefined,
    senderName: m.fromName ?? null,
  });
  return box.email;
}
