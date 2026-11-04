import dns from "node:dns/promises";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { Prisma, type Mailbox } from "@prisma/client";
import { db } from "../db";
import { open, seal, type SecretBox } from "../secret-box";
import { can } from "../iotx/permissions";
import { guessProvider, providerById } from "./providers";

/**
 * Mailboxes connected over IMAP (reading) and SMTP (sending). A personal
 * mailbox belongs to one person; a shared one (ownerId null) is used by the
 * people an admin assigns. Passwords are sealed at rest and never sent to the
 * browser.
 */
const PURPOSE = "mailbox";

export class MailError extends Error {}

export type MailboxInput = {
  email: string;
  displayName?: string;
  provider?: string;
  password?: string;
  username?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
};

/** What the browser may see about a mailbox. */
export function publicMailbox(m: Mailbox) {
  const { secret: _secret, ...rest } = m;
  return { ...rest, sharedWith: Array.isArray(m.sharedWith) ? (m.sharedWith as string[]) : [] };
}

export const passwordOf = (m: Pick<Mailbox, "secret">) => open(PURPOSE, m.secret as unknown as SecretBox);

/** Provider from the address's mail servers (MX), for custom domains on Google, Zoho, Hostinger or Microsoft. */
export async function detectProvider(email: string): Promise<string> {
  const quick = guessProvider(email);
  if (quick) return quick;
  const domain = email.split("@")[1];
  if (!domain) return "custom";
  try {
    const mx = (await dns.resolveMx(domain)).map((r) => r.exchange.toLowerCase()).join(" ");
    if (/google\.com|googlemail\.com/.test(mx)) return "google";
    if (/zoho\./.test(mx)) return "zoho";
    if (/hostinger\./.test(mx)) return "hostinger";
    if (/outlook\.com|protection\.outlook/.test(mx)) return "outlook";
  } catch {}
  return "custom";
}

type Conn = Pick<Mailbox, "imapHost" | "imapPort" | "imapSecure" | "smtpHost" | "smtpPort" | "smtpSecure" | "username"> & { password: string };

export function imapClient(c: Conn) {
  return new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapSecure,
    auth: { user: c.username, pass: c.password },
    logger: false,
    socketTimeout: 60_000,
    greetingTimeout: 15_000,
    connectionTimeout: 15_000,
  });
}

export function smtpTransport(c: Conn) {
  return nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpSecure,
    // Port 587 upgrades with STARTTLS; plain ports (local test servers) don't.
    requireTLS: !c.smtpSecure && c.smtpPort === 587,
    auth: { user: c.username, pass: c.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

/** Signs in to both servers; throws a MailError a person can act on. */
export async function testConnection(c: Conn) {
  const imap = imapClient(c);
  try {
    await imap.connect();
  } catch (e) {
    throw new MailError(`Couldn't sign in to read mail (${c.imapHost}): ${friendly(e)}`);
  } finally {
    await imap.logout().catch(() => undefined);
  }
  try {
    await smtpTransport(c).verify();
  } catch (e) {
    throw new MailError(`Signed in to read mail, but couldn't sign in to send (${c.smtpHost}): ${friendly(e)}`);
  }
}

function friendly(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const extra = (e as { responseText?: string; response?: string })?.responseText ?? (e as { response?: string })?.response ?? "";
  const all = `${msg} ${extra}`;
  if ((e as { authenticationFailed?: boolean })?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|Invalid login|535|authentication failed|Username and Password not accepted/i.test(all))
    return "the address or password was rejected. Gmail and Google Workspace need an app password, not the normal one.";
  if (/ENOTFOUND|EAI_AGAIN/.test(all)) return "that server name doesn't exist.";
  if (/ETIMEDOUT|timeout/i.test(all)) return "the server didn't answer in time.";
  if (/ECONNREFUSED/.test(all)) return "the server refused the connection (check the port).";
  return msg.slice(0, 200);
}

function settingsFrom(input: MailboxInput, provider: string, existing?: Mailbox) {
  const p = providerById(provider);
  const pick = <T,>(v: T | undefined, fromExisting: T | undefined, fromPreset: T) => (v !== undefined && v !== "" ? v : fromExisting ?? fromPreset);
  return {
    imapHost: String(pick(input.imapHost, existing?.imapHost, p.imapHost)).trim(),
    imapPort: Number(pick(input.imapPort, existing?.imapPort, p.imapPort)),
    imapSecure: Boolean(pick(input.imapSecure, existing?.imapSecure, p.imapSecure)),
    smtpHost: String(pick(input.smtpHost, existing?.smtpHost, p.smtpHost)).trim(),
    smtpPort: Number(pick(input.smtpPort, existing?.smtpPort, p.smtpPort)),
    smtpSecure: Boolean(pick(input.smtpSecure, existing?.smtpSecure, p.smtpSecure)),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add a mailbox after checking it signs in. ownerId null = shared company mailbox. */
export async function addMailbox(workspaceId: string, createdById: string, ownerId: string | null, input: MailboxInput) {
  const email = input.email?.trim().toLowerCase();
  if (!email || !EMAIL.test(email)) throw new MailError("Enter a valid email address.");
  if (!input.password) throw new MailError("Enter the mailbox password or app password.");
  if (await db.mailbox.findUnique({ where: { workspaceId_email: { workspaceId, email } } })) throw new MailError("That mailbox is already connected in this workspace.");
  const provider = input.provider && input.provider !== "auto" ? input.provider : await detectProvider(email);
  const s = settingsFrom(input, provider);
  if (!s.imapHost || !s.smtpHost) throw new MailError("Enter the IMAP and SMTP servers for this provider.");
  const username = input.username?.trim() || email;
  await testConnection({ ...s, username, password: input.password });
  return db.mailbox.create({
    data: {
      workspaceId,
      ownerId,
      email,
      displayName: input.displayName?.trim().slice(0, 80) || null,
      provider,
      ...s,
      username,
      secret: seal(PURPOSE, input.password) as unknown as Prisma.InputJsonValue,
      status: "ok",
      createdById,
      sharedWith: [],
    },
  });
}

/** Change settings or the password; re-tests before saving. */
export async function updateMailbox(m: Mailbox, input: MailboxInput) {
  if (m.authType === "gmail") throw new MailError("This mailbox uses Sign in with Google. Reconnect it with Google instead of changing a password.");
  const provider = input.provider && input.provider !== "auto" ? input.provider : m.provider;
  const s = settingsFrom(input, provider, m);
  const username = input.username?.trim() || m.username;
  const password = input.password || passwordOf(m);
  await testConnection({ ...s, username, password });
  return db.mailbox.update({
    where: { id: m.id },
    data: {
      provider,
      ...s,
      username,
      displayName: input.displayName !== undefined ? input.displayName.trim().slice(0, 80) || null : undefined,
      secret: input.password ? (seal(PURPOSE, input.password) as unknown as Prisma.InputJsonValue) : undefined,
      status: "ok",
      lastError: null,
    },
  });
}

/** Mailbox admins: people with "Manage company mailboxes". */
export const isMailAdmin = (userId: string, workspaceId: string) => can(userId, workspaceId, "admin.mailboxes");

/** Mailboxes this person can open in Mail: their own, plus shared ones assigned to them. */
export async function mailboxesFor(userId: string, workspaceId: string) {
  const all = await db.mailbox.findMany({ where: { workspaceId }, orderBy: [{ ownerId: "asc" }, { email: "asc" }] });
  const shared = await can(userId, workspaceId, "mail.shared");
  return all.filter((m) => m.ownerId === userId || (m.ownerId === null && shared && (m.sharedWith as string[] | null)?.includes(userId)));
}

/** Load a mailbox the person may use, or throw 404. */
export async function usableMailbox(userId: string, workspaceId: string, mailboxId: string) {
  const m = (await mailboxesFor(userId, workspaceId)).find((x) => x.id === mailboxId);
  if (!m) throw new Response(JSON.stringify({ error: "Mailbox not found" }), { status: 404, headers: { "content-type": "application/json" } });
  return m;
}
