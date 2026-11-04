import type { AppManifest } from "../types";

/** Mail: company and personal mailboxes over IMAP/SMTP, read and sent inside IOTx, with AI help. */
export const mail: AppManifest = {
  id: "mail",
  name: "Mail",
  desc: "Email",
  color: "linear-gradient(135deg,#dc2626,#f87171)",
  icon: "mail",
  status: "live",
  href: "/mail",
  order: 8,
  features: [
    { key: "mail.connect", label: "Connect their own mailbox", group: "Mailboxes", hint: "Personal mailbox with an app password" },
    { key: "mail.shared", label: "Use shared mailboxes they're given", group: "Mailboxes", hint: "e.g. sales@ or accounts@, assigned by an admin" },
    { key: "mail.send", label: "Send and reply", group: "Mail" },
    { key: "mail.ai", label: "AI summaries, drafts and sorting", group: "Mail" },
  ],
};
