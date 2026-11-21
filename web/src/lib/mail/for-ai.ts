import { db } from "../db";
import { can } from "../iotx/permissions";
import { mailboxesFor } from "./mailbox";
import { attachment, openMessage } from "./sync";

/**
 * Mail for the AI (the Builder agent, @ references): the person's own mailboxes and the shared
 * ones they may use, nothing else. Read as the person who asked.
 */

async function usable(userId: string, workspaceId: string) {
  if (!(await can(userId, workspaceId, "mail.open"))) return [];
  return mailboxesFor(userId, workspaceId);
}

export type MailHit = { id: string; mailboxId: string; mailbox: string; folder: string; date: string; from: string; subject: string; snippet: string; attachments: { part: string; name: string; type: string; size?: number }[] };

type AttMeta = { part?: string; filename?: string; type?: string; size?: number };
const atts = (a: unknown) => ((a as AttMeta[] | null) ?? []).filter((x) => x.part).map((x) => ({ part: x.part!, name: x.filename ?? "attachment", type: x.type ?? "application/octet-stream", size: x.size }));

/** Latest messages matching sender, subject or words, newest first (received mail by default). */
export async function findMail(userId: string, workspaceId: string, q: { from?: string; subject?: string; text?: string; days?: number; limit?: number; sent?: boolean }) {
  const boxes = await usable(userId, workspaceId);
  if (!boxes.length) return { mailboxes: [] as string[], messages: [] as MailHit[] };
  const like = (v: string) => ({ contains: v.trim().slice(0, 100), mode: "insensitive" as const });
  const rows = await db.mailMessage.findMany({
    where: {
      mailboxId: { in: boxes.map((b) => b.id) },
      folder: q.sent ? { contains: "sent", mode: "insensitive" } : { equals: "INBOX", mode: "insensitive" },
      ...(q.from ? { OR: [{ fromAddr: like(q.from) }, { fromName: like(q.from) }] } : {}),
      ...(q.subject ? { subject: like(q.subject) } : {}),
      ...(q.text ? { AND: [{ OR: [{ subject: like(q.text) }, { snippet: like(q.text) }, { text: like(q.text) }] }] } : {}),
      ...(q.days ? { date: { gte: new Date(Date.now() - q.days * 86_400_000) } } : {}),
    },
    orderBy: { date: "desc" },
    take: Math.min(Math.max(q.limit ?? 10, 1), 25),
    select: { id: true, mailboxId: true, folder: true, date: true, fromAddr: true, fromName: true, subject: true, snippet: true, attachments: true },
  });
  const name = new Map(boxes.map((b) => [b.id, b.email]));
  return {
    mailboxes: boxes.map((b) => b.email),
    messages: rows.map((r) => ({
      id: r.id,
      mailboxId: r.mailboxId,
      mailbox: name.get(r.mailboxId) ?? "",
      folder: r.folder,
      date: r.date?.toISOString() ?? "",
      from: r.fromName ? `${r.fromName} <${r.fromAddr}>` : (r.fromAddr ?? ""),
      subject: r.subject ?? "",
      snippet: r.snippet ?? "",
      attachments: atts(r.attachments),
    })),
  };
}

async function box(userId: string, workspaceId: string, messageId: string) {
  const row = await db.mailMessage.findUnique({ where: { id: messageId }, select: { mailboxId: true } });
  const b = row && (await usable(userId, workspaceId)).find((x) => x.id === row.mailboxId);
  if (!b) throw new Error("That email isn't in a mailbox you can use.");
  return b;
}

const strip = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** One email: headers, body as text, and its attachments. */
export async function readMail(userId: string, workspaceId: string, messageId: string) {
  const b = await box(userId, workspaceId, messageId);
  const m = (await openMessage(b, messageId)) as {
    id: string; subject?: string | null; fromAddr?: string | null; fromName?: string | null; to?: unknown; date?: Date | null; text?: string | null; html?: string | null; attachments?: unknown;
  } | null;
  if (!m) throw new Error("That email couldn't be opened.");
  const body = (m.text?.trim() || (m.html ? strip(m.html) : "")).slice(0, 40_000);
  return {
    id: m.id,
    mailbox: b.email,
    date: m.date ? new Date(m.date).toISOString() : "",
    from: m.fromName ? `${m.fromName} <${m.fromAddr}>` : (m.fromAddr ?? ""),
    to: m.to,
    subject: m.subject ?? "",
    body,
    attachments: atts(m.attachments),
  };
}

/** An attachment's bytes, for the Builder to attach to the build. */
export async function mailAttachment(userId: string, workspaceId: string, messageId: string, part: string) {
  const b = await box(userId, workspaceId, messageId);
  const f = await attachment(b, messageId, part);
  if (!f) throw new Error("That attachment isn't there.");
  return { name: f.filename, type: f.type, data: f.bytes as Buffer };
}
