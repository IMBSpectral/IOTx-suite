import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { requirePerm } from "@/lib/iotx/permissions";
import { MailError, usableMailbox } from "@/lib/mail/mailbox";
import { attachment, listFolders, openMessage, sendMail, setSeen, syncFolder } from "@/lib/mail/sync";
import { classify, draftReply, summarize } from "@/lib/mail/ai";
import { bodyFor, recipientsFor } from "@/lib/mail/outgoing";
import { domainsOf } from "@/lib/mail/compose";
import { InsufficientCredits, SpendLimitReached } from "@/lib/credits";

/**
 * Reading and sending mail.
 *   GET ?view=folders&mailbox=                       -> { folders }
 *   GET ?view=messages&mailbox=&folder=&q=&before=   -> { messages, more }   (syncs first if never synced)
 *   GET ?view=message&mailbox=&id=                    -> { message }          (body fetched once, marks read)
 *   GET ?view=attachment&mailbox=&id=&part=          -> the file
 *   GET ?view=contacts&mailbox=                      -> { contacts, domains }  (for To/Cc/Bcc autocomplete)
 *   POST { action: "sync", mailbox, folder }
 *   POST { action: "seen" | "unseen", mailbox, id }
 *   POST { action: "send", mailbox, to, cc?, bcc?, subject, html?, text?, replyTo? }
 *        to/cc/bcc: "a@x.com, B <b@y.com>" or an array; every address is checked (400 names a bad one).
 *        html is sanitized and a plain-text part made from it (multipart/alternative).
 *   POST { action: "summarize" | "classify" | "draft", mailbox, id, instruction? }
 *   POST { action: "sort", mailbox, ids }            label up to 20 messages
 */
const PAGE = 50;
const folderCache = new Map<string, { at: number; folders: unknown }>();
const contactCache = new Map<string, { at: number; value: { contacts: Contact[]; domains: string[] } }>();
type Contact = { name: string | null; address: string; n: number; member?: boolean };

/**
 * Who the person writes to: everyone in the From, To and Cc of this
 * mailbox's synced mail (most frequent first) and the workspace's members.
 */
async function contactsFor(mailbox: { id: string; email: string }, workspaceId: string, userEmail: string | null) {
  const key = `${mailbox.id}:${workspaceId}`;
  const hit = contactCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const rows = await db.mailMessage.findMany({ where: { mailboxId: mailbox.id }, orderBy: { date: "desc" }, take: 3000, select: { fromAddr: true, fromName: true, to: true, cc: true } });
  const seen = new Map<string, Contact>();
  const add = (address: string | null | undefined, name: string | null | undefined, member = false) => {
    const a = (address ?? "").trim().toLowerCase();
    if (!a.includes("@") || a.length > 254 || /no-?reply|mailer-daemon|postmaster/.test(a)) return;
    const c = seen.get(a) ?? { name: null, address: a, n: 0 };
    c.n++;
    if (name && !c.name && name.toLowerCase() !== a) c.name = name.trim().slice(0, 120);
    if (member) c.member = true;
    seen.set(a, c);
  };
  for (const r of rows) {
    add(r.fromAddr, r.fromName);
    for (const x of [...((r.to as { name?: string | null; address?: string }[] | null) ?? []), ...((r.cc as { name?: string | null; address?: string }[] | null) ?? [])]) add(x?.address, x?.name ?? null);
  }
  const members = await db.membership.findMany({ where: { workspaceId }, select: { user: { select: { email: true, name: true } } }, take: 1000 });
  for (const m of members) add(m.user.email, m.user.name, true);
  seen.delete(mailbox.email.toLowerCase());
  const contacts = [...seen.values()].sort((a, b) => Number(!!b.member) - Number(!!a.member) || b.n - a.n).slice(0, 2000);
  const domains = domainsOf([mailbox.email, userEmail, ...contacts.map((c) => c.address)]);
  const value = { contacts, domains };
  contactCache.set(key, { at: Date.now(), value });
  return value;
}

async function context(mailboxId: string | null) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requirePerm(user.id, ws.id, "mail.open");
  if (!mailboxId) throw new Response(JSON.stringify({ error: "Choose a mailbox" }), { status: 400 });
  const mailbox = await usableMailbox(user.id, ws.id, mailboxId);
  return { user, ws, mailbox };
}

async function GET_(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const { user, ws, mailbox } = await context(q.get("mailbox"));
  try {
    switch (q.get("view")) {
      case "contacts":
        return Response.json(await contactsFor(mailbox, ws.id, user.email ?? null));
      case "folders": {
        const hit = folderCache.get(mailbox.id);
        if (hit && Date.now() - hit.at < 60_000 && !q.get("fresh")) return Response.json({ folders: hit.folders });
        const folders = await listFolders(mailbox);
        folderCache.set(mailbox.id, { at: Date.now(), folders });
        return Response.json({ folders });
      }
      case "messages": {
        const folder = q.get("folder") || "INBOX";
        const known = await db.mailMessage.count({ where: { mailboxId: mailbox.id, folder } });
        if (!known) await syncFolder(mailbox, folder).catch(() => undefined);
        const search = q.get("q")?.trim();
        const before = q.get("before");
        const rows = await db.mailMessage.findMany({
          where: {
            mailboxId: mailbox.id,
            folder,
            ...(before ? { date: { lt: new Date(before) } } : {}),
            ...(search
              ? { OR: [{ subject: { contains: search, mode: "insensitive" } }, { fromAddr: { contains: search, mode: "insensitive" } }, { fromName: { contains: search, mode: "insensitive" } }, { snippet: { contains: search, mode: "insensitive" } }] }
              : {}),
          },
          orderBy: { date: "desc" },
          take: PAGE + 1,
          select: { id: true, fromAddr: true, fromName: true, to: true, subject: true, snippet: true, date: true, seen: true, flagged: true, hasAttachments: true, aiLabel: true },
        });
        return Response.json({ messages: rows.slice(0, PAGE), more: rows.length > PAGE });
      }
      case "message": {
        const id = q.get("id") ?? "";
        const message = await openMessage(mailbox, id);
        if (!message) return Response.json({ error: "Message not found" }, { status: 404 });
        if (!message.seen) await setSeen(mailbox, id, true).catch(() => undefined);
        return Response.json({ message: { ...message, seen: true } });
      }
      case "attachment": {
        const file = await attachment(mailbox, q.get("id") ?? "", q.get("part") ?? "");
        if (!file) return new Response("Not found", { status: 404 });
        const safeName = file.filename.replace(/["\r\n]/g, "");
        return new Response(new Uint8Array(file.bytes), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "x-content-type-options": "nosniff",
          },
        });
      }
      default:
        return Response.json({ error: "Unknown view" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MailError) return Response.json({ error: e.message }, { status: 502 });
    throw e;
  }
}

async function POST_(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const { user, ws, mailbox } = await context(typeof body.mailbox === "string" ? body.mailbox : null);
  const id = String(body.id ?? "");
  try {
    switch (body.action) {
      case "sync": {
        folderCache.delete(mailbox.id);
        return Response.json({ synced: await syncFolder(mailbox, String(body.folder || "INBOX")) });
      }
      case "seen":
      case "unseen":
        await setSeen(mailbox, id, body.action === "seen");
        return Response.json({ ok: true });
      case "send": {
        await requirePerm(user.id, ws.id, "mail.send");
        const replyTo = body.replyTo ? await db.mailMessage.findFirst({ where: { id: String(body.replyTo), mailboxId: mailbox.id } }) : null;
        const { domains } = await contactsFor(mailbox, ws.id, user.email ?? null);
        const rcpt = recipientsFor(body, [mailbox.email, user.email, ...domains.map((d) => `x@${d}`)]);
        const sent = await sendMail(mailbox, {
          ...rcpt,
          subject: String(body.subject ?? ""),
          ...bodyFor(body),
          inReplyTo: replyTo?.messageId ?? null,
          references: replyTo?.messageId ? [replyTo.inReplyTo, replyTo.messageId].filter(Boolean).join(" ") : null,
          senderName: user.name ?? null,
        });
        contactCache.delete(`${mailbox.id}:${ws.id}`);
        return Response.json(sent);
      }
      case "summarize":
      case "classify":
      case "draft": {
        await requirePerm(user.id, ws.id, "mail.ai");
        const m = (await openMessage(mailbox, id)) ?? null;
        if (!m) return Response.json({ error: "Message not found" }, { status: 404 });
        if (body.action === "summarize") return Response.json({ summary: await summarize(ws.id, user.id, m) });
        if (body.action === "classify") return Response.json({ label: await classify(ws.id, user.id, m) });
        return Response.json({ draft: await draftReply(ws.id, user.id, m, user.name ?? null, typeof body.instruction === "string" ? body.instruction : undefined) });
      }
      case "sort": {
        await requirePerm(user.id, ws.id, "mail.ai");
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 20);
        const labels: Record<string, string> = {};
        for (const mid of ids) {
          const m = await openMessage(mailbox, mid).catch(() => null);
          if (m && !m.aiLabel) labels[mid] = await classify(ws.id, user.id, m);
        }
        return Response.json({ labels });
      }
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MailError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof InsufficientCredits || e instanceof SpendLimitReached) return Response.json({ error: "You're out of AI credits or at a spending limit." }, { status: 402 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
