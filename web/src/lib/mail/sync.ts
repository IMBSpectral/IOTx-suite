import { simpleParser, type AddressObject } from "mailparser";
import sanitizeHtml from "sanitize-html";
import MailComposer from "nodemailer/lib/mail-composer";
import { Prisma, type Mailbox } from "@prisma/client";
import { db } from "../db";
import { imapClient, passwordOf, smtpTransport, MailError } from "./mailbox";
import { providerById } from "./providers";

/**
 * Reading and sending: folder lists, syncing the newest messages of a folder
 * into the database, opening a message (body parsed, cleaned and cached),
 * read/unread, and sending through the mailbox's own SMTP server.
 */
const SYNC_LIMIT = 150;

export type Folder = { path: string; name: string; role: "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | null; unseen?: number };

async function withImap<T>(m: Mailbox, fn: (c: ReturnType<typeof imapClient>) => Promise<T>): Promise<T> {
  const c = imapClient({ ...m, password: passwordOf(m) });
  try {
    await c.connect();
  } catch (e) {
    await db.mailbox.update({ where: { id: m.id }, data: { status: "error", lastError: e instanceof Error ? e.message.slice(0, 300) : "Sign-in failed" } });
    throw new MailError("Couldn't sign in to this mailbox. Its password may have changed: ask an admin to update it, or reconnect it.");
  }
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => undefined);
  }
}

const ROLE: Record<string, Folder["role"]> = { "\\Inbox": "inbox", "\\Sent": "sent", "\\Drafts": "drafts", "\\Trash": "trash", "\\Junk": "junk", "\\Archive": "archive", "\\All": "archive" };

const gmail = () => import("./gmail");
const isGmail = (m: Mailbox) => m.authType === "gmail";

export async function listFolders(m: Mailbox): Promise<Folder[]> {
  if (isGmail(m)) return (await gmail()).gmailFolders(m);
  return withImap(m, async (c) => {
    const list = await c.list({ statusQuery: { unseen: true } });
    const out: Folder[] = list
      .filter((f) => !f.flags?.has("\\Noselect"))
      .map((f) => ({
        path: f.path,
        name: f.path.toUpperCase() === "INBOX" ? "Inbox" : f.name,
        role: f.path.toUpperCase() === "INBOX" ? "inbox" : (f.specialUse ? ROLE[f.specialUse] ?? null : null),
        unseen: f.status?.unseen,
      }));
    const order = ["inbox", "sent", "drafts", "archive", "junk", "trash"];
    return out.sort((a, b) => (order.indexOf(a.role ?? "") + 1 || 99) - (order.indexOf(b.role ?? "") + 1 || 99) || a.name.localeCompare(b.name));
  });
}

const addrs = (a?: AddressObject | AddressObject[]) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value).map((v) => ({ name: v.name || null, address: v.address ?? "" }));

/** Pull the newest messages of a folder (headers, flags, a snippet). */
export async function syncFolder(m: Mailbox, folder = "INBOX") {
  if (isGmail(m)) return (await gmail()).gmailSync(m, folder);
  const count = await withImap(m, async (c) => {
    const lock = await c.getMailboxLock(folder);
    let n = 0;
    try {
      const exists = typeof c.mailbox === "object" && c.mailbox ? c.mailbox.exists : 0;
      if (!exists) return 0;
      const from = Math.max(1, exists - SYNC_LIMIT + 1);
      for await (const msg of c.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: ["in-reply-to"] })) {
        const env = msg.envelope;
        if (!env) continue;
        const parts: { filename?: string; size?: number; type?: string; part?: string }[] = [];
        const walk = (n: unknown) => {
          const node = n as { disposition?: string; dispositionParameters?: { filename?: string }; parameters?: { name?: string }; size?: number; type?: string; part?: string; childNodes?: unknown[] };
          if (!node) return;
          const name = node.dispositionParameters?.filename ?? node.parameters?.name;
          if (node.disposition === "attachment" || (name && node.type && !node.type.startsWith("text/"))) parts.push({ filename: name, size: node.size, type: node.type, part: node.part });
          node.childNodes?.forEach(walk);
        };
        walk(msg.bodyStructure);
        const from0 = env.from?.[0];
        const data = {
          messageId: env.messageId ?? null,
          inReplyTo: env.inReplyTo ?? null,
          fromAddr: from0?.address ?? "",
          fromName: from0?.name || null,
          to: (env.to ?? []).map((a) => ({ name: a.name || null, address: a.address ?? "" })),
          cc: (env.cc ?? []).map((a) => ({ name: a.name || null, address: a.address ?? "" })),
          subject: env.subject || "(no subject)",
          date: env.date ?? (msg.internalDate instanceof Date ? msg.internalDate : new Date()),
          seen: msg.flags?.has("\\Seen") ?? false,
          flagged: msg.flags?.has("\\Flagged") ?? false,
          hasAttachments: parts.length > 0,
          attachments: parts.length ? (parts as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        };
        await db.mailMessage.upsert({
          where: { mailboxId_folder_uid: { mailboxId: m.id, folder, uid: msg.uid } },
          create: { mailboxId: m.id, folder, uid: msg.uid, ...data },
          update: { seen: data.seen, flagged: data.flagged },
        });
        n++;
      }
      // Messages deleted on the server disappear here too.
      const uids = await c.search({ all: true }, { uid: true });
      if (Array.isArray(uids)) {
        const keep = new Set(uids);
        const local = await db.mailMessage.findMany({ where: { mailboxId: m.id, folder }, select: { id: true, uid: true } });
        const gone = local.filter((x) => !keep.has(x.uid)).map((x) => x.id);
        if (gone.length) await db.mailMessage.deleteMany({ where: { id: { in: gone } } });
      }
    } finally {
      lock.release();
    }
    return n;
  });
  await db.mailbox.update({ where: { id: m.id }, data: { lastSyncAt: new Date(), status: "ok", lastError: null } });
  return count;
}

export const CLEAN: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "span", "font", "center", "h1", "h2", "u", "s"]),
  allowedAttributes: { "*": ["style", "align", "width", "height", "colspan", "rowspan", "bgcolor", "color"], a: ["href", "title"], img: ["src", "alt", "width", "height"] },
  allowedSchemes: ["http", "https", "mailto", "data", "cid"],
  allowedSchemesByTag: { img: ["https", "data", "cid"] },
  transformTags: { a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }) },
};

/** Open one message: fetch and parse its body once, then serve it from the database. */
export async function openMessage(m: Mailbox, id: string) {
  if (isGmail(m)) return (await gmail()).gmailOpen(m, id);
  const msg = await db.mailMessage.findFirst({ where: { id, mailboxId: m.id } });
  if (!msg) return null;
  if (msg.html !== null || msg.text !== null) return msg;
  const parsed = await withImap(m, async (c) => {
    const lock = await c.getMailboxLock(msg.folder);
    try {
      const one = await c.fetchOne(String(msg.uid), { source: true }, { uid: true });
      return one && one.source ? simpleParser(one.source) : null;
    } finally {
      lock.release();
    }
  });
  if (!parsed) return msg;
  const html = parsed.html ? sanitizeHtml(String(parsed.html), CLEAN) : null;
  const text = parsed.text ?? null;
  const snippet = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return db.mailMessage.update({ where: { id: msg.id }, data: { html, text: text?.slice(0, 200_000) ?? null, snippet } });
}

/** One attachment's bytes, straight from the server. */
export async function attachment(m: Mailbox, id: string, part: string) {
  if (isGmail(m)) return (await gmail()).gmailAttachment(m, id, part);
  const msg = await db.mailMessage.findFirst({ where: { id, mailboxId: m.id } });
  if (!msg) return null;
  const meta = ((msg.attachments as { part?: string; filename?: string; type?: string }[] | null) ?? []).find((a) => a.part === part);
  if (!meta) return null;
  return withImap(m, async (c) => {
    const lock = await c.getMailboxLock(msg.folder);
    try {
      const { content } = await c.download(String(msg.uid), part, { uid: true });
      const chunks: Buffer[] = [];
      for await (const ch of content) chunks.push(ch as Buffer);
      return { bytes: Buffer.concat(chunks), filename: meta.filename ?? "attachment", type: meta.type ?? "application/octet-stream" };
    } finally {
      lock.release();
    }
  });
}

export async function setSeen(m: Mailbox, id: string, seen: boolean) {
  if (isGmail(m)) return (await gmail()).gmailSeen(m, id, seen);
  const msg = await db.mailMessage.findFirst({ where: { id, mailboxId: m.id } });
  if (!msg || msg.seen === seen) return;
  await withImap(m, async (c) => {
    const lock = await c.getMailboxLock(msg.folder);
    try {
      if (seen) await c.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
      else await c.messageFlagsRemove(String(msg.uid), ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  });
  await db.mailMessage.update({ where: { id: msg.id }, data: { seen } });
}

/** icalEvent: a calendar invite (METHOD REQUEST/CANCEL/REPLY) that mail apps show with Accept / Decline. */
export type Outgoing = { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; inReplyTo?: string | null; references?: string | null; senderName?: string | null; icalEvent?: { method: string; content: string } | null };

/** The mail server's words for a refused message, put plainly ("Invalid To header" and the like). */
export function friendlySendError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/invalid (to|cc|bcc) header|invalid recipient|recipient address rejected|recipients were rejected|bad recipient|no recipients/i.test(msg))
    return "One of the addresses wasn't accepted by the mail server. Check that each one is complete, like name@company.com.";
  return `Couldn't send: ${msg ? msg.slice(0, 200) : "the mail server refused it"}`;
}

/** Send through the mailbox's SMTP server; keep a copy in Sent when the provider doesn't. */
export async function sendMail(m: Mailbox, o: Outgoing) {
  if (isGmail(m)) return (await gmail()).gmailSend(m, o);
  const to = o.to.map((s) => s.trim()).filter(Boolean);
  if (!to.length && !o.cc?.length && !o.bcc?.length) throw new MailError("Add at least one recipient.");
  if (to.length + (o.cc?.length ?? 0) + (o.bcc?.length ?? 0) > 50) throw new MailError("Send to 50 people or fewer at a time.");
  const password = passwordOf(m);
  const name = m.displayName || o.senderName || undefined;
  const message = {
    from: name ? { name, address: m.email } : m.email,
    to,
    cc: o.cc?.filter(Boolean),
    bcc: o.bcc?.filter(Boolean),
    subject: o.subject.slice(0, 300) || "(no subject)",
    text: o.text,
    html: o.html,
    inReplyTo: o.inReplyTo ?? undefined,
    references: o.references ?? o.inReplyTo ?? undefined,
  };
  let info;
  try {
    info = await smtpTransport({ ...m, password }).sendMail(message);
  } catch (e) {
    throw new MailError(friendlySendError(e));
  }
  if (!providerById(m.provider).autoSent) {
    // Build the same message as raw MIME and file it in Sent.
    const raw = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer({ ...message, messageId: info.messageId, date: new Date() }).compile().build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf)));
    }).catch(() => null);
    if (raw) {
      await withImap(m, async (c) => {
        const sent = (await c.list()).find((f) => f.specialUse === "\\Sent");
        if (sent) await c.append(sent.path, raw, ["\\Seen"]);
      }).catch(() => undefined);
    }
  }
  return { messageId: info.messageId as string };
}
