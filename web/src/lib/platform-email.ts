import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import { getBrand } from "./brand";

/**
 * The platform's own emails (sign-in and welcome emails, access-request
 * outcomes). Sent over SMTP from a mailbox you own when FORGE_SMTP_HOST,
 * FORGE_SMTP_USER and FORGE_SMTP_PASSWORD are set (e.g. sales@ on Google
 * Workspace with an app password); else through Resend when
 * FORGE_RESEND_API_KEY and FORGE_EMAIL_FROM are set; otherwise they are kept in _forge/outbox.jsonl, so nothing
 * is lost before an email provider is connected.
 */

const OUTBOX = path.join(PROJECTS_ROOT, "_forge", "outbox.jsonl");

/** html and icalEvent are optional; icalEvent makes the email a calendar invite mail apps can answer. */
export async function sendPlatformEmail(m: { to: string; subject: string; text: string; html?: string; icalEvent?: { method: string; content: string }; fromName?: string }) {
  const entry = { at: new Date().toISOString(), ...m, status: "captured" as "captured" | "sent" | "failed", error: undefined as string | undefined };
  const key = process.env.FORGE_RESEND_API_KEY;
  const from = process.env.FORGE_EMAIL_FROM;
  const smtp = { host: process.env.FORGE_SMTP_HOST, user: process.env.FORGE_SMTP_USER, pass: process.env.FORGE_SMTP_PASSWORD };
  // FORGE_SYSTEM_MAILBOX: a mailbox connected with "Sign in with Google" sends over Google's
  // HTTPS API, which works where a host blocks SMTP ports.
  const systemBox = process.env.FORGE_SYSTEM_MAILBOX
    ? await (await import("./db")).db.mailbox.findFirst({ where: { email: process.env.FORGE_SYSTEM_MAILBOX.toLowerCase(), authType: "gmail", status: "ok" } })
    : null;
  if (systemBox) {
    try {
      await (await import("./mail/gmail")).gmailSend({ ...systemBox, displayName: m.fromName ?? systemBox.displayName ?? getBrand().name }, { to: [m.to], subject: m.subject, text: m.text, html: m.html, icalEvent: m.icalEvent ?? null });
      entry.status = "sent";
    } catch (e) {
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
  } else if (smtp.host && smtp.user && smtp.pass) {
    try {
      const nodemailer = (await import("nodemailer")).default;
      const port = Number(process.env.FORGE_SMTP_PORT ?? 465);
      await nodemailer
        .createTransport({ host: smtp.host, port, secure: port === 465, requireTLS: port !== 465, auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 15_000 })
        .sendMail({ from: from ?? { name: m.fromName ?? getBrand().name, address: smtp.user }, to: m.to, subject: m.subject, text: m.text, html: m.html, ...(m.icalEvent ? { icalEvent: { method: m.icalEvent.method, content: m.icalEvent.content, filename: "invite.ics" } } : {}) });
      entry.status = "sent";
    } catch (e) {
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
  } else if (key && from) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.icalEvent ? { attachments: [{ filename: "invite.ics", content: Buffer.from(m.icalEvent.content).toString("base64"), content_type: `text/calendar; method=${m.icalEvent.method}` }] } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      entry.status = r.ok ? "sent" : "failed";
      if (!r.ok) entry.error = `${r.status}: ${(await r.text()).slice(0, 200)}`;
    } catch (e) {
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message : String(e);
    }
  }
  await fs.mkdir(path.dirname(OUTBOX), { recursive: true });
  await fs.appendFile(OUTBOX, JSON.stringify(entry) + "\n");
  return entry.status;
}
