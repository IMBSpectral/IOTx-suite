import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import MailComposer from "nodemailer/lib/mail-composer";
import { Prisma, type Mailbox } from "@prisma/client";
import { db } from "../db";
import { open, type SecretBox } from "../secret-box";
import { tokenRequest } from "../google";
import { MailError } from "./mailbox";
import { CLEAN, friendlySendError, type Folder, type Outgoing } from "./sync";

/**
 * Google mailboxes connected with "Sign in with Google": the same operations
 * as IMAP/SMTP (folders, sync, open, attachments, read/unread, send), through
 * the Gmail API over HTTPS. Works where SMTP ports are blocked, needs no app
 * password, and keeps Gmail in step (sent mail lands in Gmail's Sent).
 */
export const GMAIL_PURPOSE = "gmail-refresh";
export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"];
// FORGE_GMAIL_API: tests point this at a mock.
const API = () => `${process.env.FORGE_GMAIL_API ?? "https://gmail.googleapis.com"}/gmail/v1/users/me`;
const SYNC_LIMIT = 150;

const tokens = new Map<string, { token: string; until: number }>();

async function token(m: Mailbox) {
  const hit = tokens.get(m.id);
  if (hit && hit.until > Date.now()) return hit.token;
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: open(GMAIL_PURPOSE, m.secret as unknown as SecretBox) });
    tokens.set(m.id, { token: t.access_token!, until: Date.now() + ((t.expires_in ?? 3600) - 120) * 1000 });
    return t.access_token!;
  } catch {
    await db.mailbox.update({ where: { id: m.id }, data: { status: "error", lastError: "Google access was removed or expired. Reconnect with Google." } });
    throw new MailError("Google access for this mailbox has expired or was removed. Reconnect it with Google.");
  }
}

async function g<T>(m: Mailbox, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await token(m)}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const d = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) {
    if (r.status === 403 && /has not been used|is disabled/i.test(d.error?.message ?? "")) throw new MailError("The Gmail API isn't switched on in the Google Cloud project yet.");
    throw new MailError(d.error?.message ?? `Gmail answered ${r.status}`);
  }
  return d;
}

/** A stable 31-bit number for a Gmail id (the uid column; remoteId keeps the real id). */
const uidOf = (id: string) => parseInt(crypto.createHash("sha1").update(id).digest("hex").slice(0, 7), 16);

const SYSTEM: Record<string, { name: string; role: Folder["role"]; order: number }> = {
  INBOX: { name: "Inbox", role: "inbox", order: 0 },
  STARRED: { name: "Starred", role: null, order: 1 },
  SENT: { name: "Sent", role: "sent", order: 2 },
  DRAFT: { name: "Drafts", role: "drafts", order: 3 },
  SPAM: { name: "Spam", role: "junk", order: 4 },
  TRASH: { name: "Trash", role: "trash", order: 5 },
};

export async function gmailFolders(m: Mailbox): Promise<Folder[]> {
  const { labels = [] } = await g<{ labels?: { id: string; name: string; type: string }[] }>(m, "/labels");
  const inbox = await g<{ messagesUnread?: number }>(m, "/labels/INBOX").catch(() => ({ messagesUnread: 0 }));
  const sys = Object.entries(SYSTEM)
    .filter(([id]) => labels.some((l) => l.id === id))
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id, v]) => ({ path: id, name: v.name, role: v.role, unseen: id === "INBOX" ? inbox.messagesUnread : undefined }));
  const user = labels.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({ path: l.id, name: l.name, role: null }));
  return [...sys, ...user];
}

type Part = { partId?: string; mimeType?: string; filename?: string; body?: { attachmentId?: string; size?: number }; parts?: Part[]; headers?: { name: string; value: string }[] };
type GMsg = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };

function addresses(v: string | undefined) {
  if (!v) return [];
  return v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => {
    const m = s.trim().match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    return m ? { name: m[1].trim() || null, address: m[2].trim() } : { name: null, address: s.trim() };
  }).filter((a) => a.address);
}

export async function gmailSync(m: Mailbox, folder = "INBOX") {
  const list = await g<{ messages?: { id: string }[] }>(m, `/messages?${new URLSearchParams({ labelIds: folder, maxResults: String(SYNC_LIMIT) })}`);
  const ids = (list.messages ?? []).map((x) => x.id);
  const known = new Map((await db.mailMessage.findMany({ where: { mailboxId: m.id, folder }, select: { id: true, remoteId: true, date: true } })).map((x) => [x.remoteId, x]));
  let n = 0;
  const fields = "id,threadId,labelIds,snippet,internalDate,payload(headers,partId,mimeType,filename,body(attachmentId,size),parts(partId,mimeType,filename,body(attachmentId,size),parts(partId,mimeType,filename,body(attachmentId,size),parts(partId,mimeType,filename,body(attachmentId,size)))))";
  for (const id of ids) {
    const exists = known.get(id);
    if (exists) {
      // Flags only, cheaply.
      const meta = await g<GMsg>(m, `/messages/${id}?format=minimal`).catch(() => null);
      if (meta) await db.mailMessage.update({ where: { id: exists.id }, data: { seen: !meta.labelIds?.includes("UNREAD"), flagged: !!meta.labelIds?.includes("STARRED") } });
      continue;
    }
    const msg = await g<GMsg>(m, `/messages/${id}?format=full&fields=${encodeURIComponent(fields)}`).catch(() => null);
    if (!msg?.payload) continue;
    const h = (name: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value;
    const atts: { filename?: string; size?: number; type?: string; part?: string }[] = [];
    const walk = (p?: Part) => {
      if (!p) return;
      if (p.filename && p.body?.attachmentId) atts.push({ filename: p.filename, size: p.body.size, type: p.mimeType, part: p.body.attachmentId });
      p.parts?.forEach(walk);
    };
    walk(msg.payload);
    const from = addresses(h("From"))[0];
    const date = h("Date") ? new Date(h("Date")!) : new Date(Number(msg.internalDate ?? Date.now()));
    await db.mailMessage.upsert({
      where: { mailboxId_folder_uid: { mailboxId: m.id, folder, uid: uidOf(id) } },
      update: {},
      create: {
        mailboxId: m.id,
        folder,
        uid: uidOf(id),
        remoteId: id,
        messageId: h("Message-ID") ?? h("Message-Id") ?? null,
        inReplyTo: h("In-Reply-To") ?? null,
        fromAddr: from?.address ?? "",
        fromName: from?.name ?? null,
        to: addresses(h("To")),
        cc: addresses(h("Cc")),
        subject: h("Subject") || "(no subject)",
        snippet: msg.snippet ? msg.snippet.slice(0, 200) : null,
        date: isNaN(date.getTime()) ? new Date() : date,
        seen: !msg.labelIds?.includes("UNREAD"),
        flagged: !!msg.labelIds?.includes("STARRED"),
        hasAttachments: atts.length > 0,
        attachments: atts.length ? (atts as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    n++;
  }
  // Removed from this label in Gmail (archived, deleted, moved) within the synced window.
  const keep = new Set(ids);
  const oldest = ids.length === SYNC_LIMIT ? Math.min(...[...known.values()].filter((k) => keep.has(k.remoteId ?? "")).map((k) => k.date.getTime())) : 0;
  const gone = [...known.values()].filter((k) => k.remoteId && !keep.has(k.remoteId) && k.date.getTime() >= oldest).map((k) => k.id);
  if (gone.length) await db.mailMessage.deleteMany({ where: { id: { in: gone } } });
  await db.mailbox.update({ where: { id: m.id }, data: { lastSyncAt: new Date(), status: "ok", lastError: null } });
  return n;
}

export async function gmailOpen(m: Mailbox, id: string) {
  const msg = await db.mailMessage.findFirst({ where: { id, mailboxId: m.id } });
  if (!msg || !msg.remoteId) return msg;
  if (msg.html !== null || msg.text !== null) return msg;
  const { raw } = await g<{ raw?: string }>(m, `/messages/${msg.remoteId}?format=raw`);
  if (!raw) return msg;
  const parsed = await simpleParser(Buffer.from(raw, "base64url"));
  const html = parsed.html ? sanitizeHtml(String(parsed.html), CLEAN) : null;
  const text = parsed.text ?? null;
  return db.mailMessage.update({ where: { id: msg.id }, data: { html, text: text?.slice(0, 200_000) ?? null, snippet: (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200) } });
}

export async function gmailAttachment(m: Mailbox, id: string, part: string) {
  const msg = await db.mailMessage.findFirst({ where: { id, mailboxId: m.id } });
  if (!msg?.remoteId) return null;
  const meta = ((msg.attachments as { part?: string; filename?: string; type?: string }[] | null) ?? []).find((a) => a.part === part);
  if (!meta) return null;
  const { data } = await g<{ data?: string }>(m, `/messages/${msg.remoteId}/attachments/${encodeURIComponent(part)}`);
  return { bytes: Buffer.from(data ?? "", "base64url"), filename: meta.filename ?? "attachment", type: meta.type ?? "application/octet-stream" };
}

export async function gmailSeen(m: Mailbox, id: string, seen: boolean) {
  const msg = await db.mailMessage.findFirst({ where: { id, mailboxId: m.id } });
  if (!msg?.remoteId || msg.seen === seen) return;
  await g(m, `/messages/${msg.remoteId}/modify`, { method: "POST", body: JSON.stringify(seen ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] }) });
  await db.mailMessage.update({ where: { id: msg.id }, data: { seen } });
}

/** Send as the mailbox through Gmail (it files the copy in Sent itself). */
export async function gmailSend(m: Mailbox, o: Outgoing & { threadOf?: string | null }) {
  const to = o.to.map((s) => s.trim()).filter(Boolean);
  if (!to.length && !o.cc?.length && !o.bcc?.length) throw new MailError("Add at least one recipient.");
  const name = m.displayName || o.senderName || undefined;
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const node = new MailComposer({
      from: name ? { name, address: m.email } : m.email,
      to,
      cc: o.cc?.filter(Boolean),
      bcc: o.bcc?.filter(Boolean),
      subject: o.subject.slice(0, 300) || "(no subject)",
      text: o.text,
      html: o.html,
      ...(o.icalEvent ? { icalEvent: { method: o.icalEvent.method, content: o.icalEvent.content, filename: "invite.ics" } } : {}),
      inReplyTo: o.inReplyTo ?? undefined,
      references: o.references ?? o.inReplyTo ?? undefined,
    }).compile();
    // Gmail reads Bcc from the raw message (and drops it before delivery), so it must stay in.
    node.keepBcc = true;
    node.build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf)));
  });
  let sent: { id: string };
  try {
    sent = await g<{ id: string }>(m, "/messages/send", { method: "POST", body: JSON.stringify({ raw: raw.toString("base64url"), ...(o.threadOf ? { threadId: o.threadOf } : {}) }) });
  } catch (e) {
    throw new MailError(friendlySendError(e));
  }
  return { messageId: sent.id };
}

/**
 * Finish "Sign in with Google" for a mailbox: store the refresh token and
 * create (or reconnect) the mailbox for the address Google signed in as.
 */
export async function connectGmail(workspaceId: string, createdById: string, ownerId: string | null, code: string, redirectUri: string) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!t.refresh_token) throw new MailError("Google didn't grant offline access. Try connecting again.");
  if (!(t.scope ?? "").includes("gmail.modify")) throw new MailError("Mail access wasn't granted. Tick the Gmail box on Google's screen and try again.");
  const email = t.id_token ? ((JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()) as { email?: string }).email ?? "").toLowerCase() : "";
  if (!email) throw new MailError("Google didn't say which address this is. Try again.");
  const { seal } = await import("../secret-box");
  const secret = seal(GMAIL_PURPOSE, t.refresh_token) as unknown as Prisma.InputJsonValue;
  const common = { provider: "google", authType: "gmail", imapHost: "gmail-api", imapPort: 443, imapSecure: true, smtpHost: "gmail-api", smtpPort: 443, smtpSecure: true, username: email, secret, status: "ok", lastError: null };
  const existing = await db.mailbox.findUnique({ where: { workspaceId_email: { workspaceId, email } } });
  if (existing) {
    // Reconnecting keeps who owns and uses it; only the person's own or an admin's reconnect reaches here.
    tokens.delete(existing.id);
    return db.mailbox.update({ where: { id: existing.id }, data: common });
  }
  return db.mailbox.create({ data: { workspaceId, ownerId, email, createdById, sharedWith: [], ...common } });
}
