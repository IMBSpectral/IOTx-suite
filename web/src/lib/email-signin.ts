import { sendPlatformEmail } from "./platform-email";
import { getBrand } from "./brand";

/**
 * "Email me a sign-in link": for people who don't use Google. The link is
 * valid for 15 minutes and works once. It's sent through the platform's own
 * sender (FORGE_SYSTEM_MAILBOX over Gmail, SMTP, or Resend). Without any of
 * those it stays off, except when FORGE_EMAIL_SIGNIN=on (local testing: the
 * link lands in _forge/outbox.jsonl).
 */
export function emailSignInEnabled() {
  if (process.env.FORGE_EMAIL_SIGNIN === "off") return false;
  if (process.env.FORGE_EMAIL_SIGNIN === "on") return true;
  return !!(process.env.FORGE_SYSTEM_MAILBOX || (process.env.FORGE_SMTP_HOST && process.env.FORGE_SMTP_PASSWORD) || process.env.FORGE_RESEND_API_KEY);
}

export async function sendSignInLink({ identifier, url }: { identifier: string; url: string }) {
  const b = getBrand();
  const status = await sendPlatformEmail({
    to: identifier,
    subject: `Your sign-in link for ${b.name}`,
    text: [
      `Hello,`,
      ``,
      `Use this link to sign in to ${b.name}. It works once and expires in 15 minutes:`,
      ``,
      url,
      ``,
      `If you didn't ask for this, you can ignore this email; nobody can sign in without the link.`,
      ``,
      `${b.company}`,
    ].join("\n"),
  });
  if (status === "failed") throw new Error("Couldn't send the sign-in email.");
}
