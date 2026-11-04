/**
 * Ready-made IMAP/SMTP settings for the common providers, so connecting a
 * mailbox is usually just an address and a password. Client-safe.
 */
export type ProviderPreset = {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** How to get the password this provider needs. */
  hint: string;
  /** Mail it saves to Sent by itself when sent over SMTP (we don't copy it there). */
  autoSent?: boolean;
};

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "google",
    label: "Gmail / Google Workspace",
    imapHost: "imap.gmail.com", imapPort: 993, imapSecure: true,
    smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true,
    hint: "Use an app password: myaccount.google.com → Security → 2-Step Verification → App passwords. Your normal password won't work.",
    autoSent: true,
  },
  {
    id: "zoho",
    label: "Zoho Mail (India)",
    imapHost: "imap.zoho.in", imapPort: 993, imapSecure: true,
    smtpHost: "smtp.zoho.in", smtpPort: 465, smtpSecure: true,
    hint: "Turn on IMAP in Zoho Mail settings, and use an app-specific password if two-factor sign-in is on.",
  },
  {
    id: "hostinger",
    label: "Hostinger Email",
    imapHost: "imap.hostinger.com", imapPort: 993, imapSecure: true,
    smtpHost: "smtp.hostinger.com", smtpPort: 465, smtpSecure: true,
    hint: "Use the mailbox password set in Hostinger → Emails.",
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    imapHost: "outlook.office365.com", imapPort: 993, imapSecure: true,
    smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecure: false,
    hint: "Your Microsoft 365 admin must allow IMAP and SMTP sign-in for this mailbox; many organizations switch it off.",
    autoSent: true,
  },
  {
    id: "custom",
    label: "Other (enter servers)",
    imapHost: "", imapPort: 993, imapSecure: true,
    smtpHost: "", smtpPort: 465, smtpSecure: true,
    hint: "Your email provider lists its IMAP and SMTP servers in its help pages.",
  },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];

/** Guess the provider from the address (gmail.com, or a known MX later). */
export function guessProvider(email: string) {
  const d = email.split("@")[1]?.toLowerCase() ?? "";
  if (d === "gmail.com" || d === "googlemail.com") return "google";
  if (/^(outlook|hotmail|live)\.com$/.test(d)) return "outlook";
  if (/^zoho(mail)?\.(in|com)$/.test(d)) return "zoho";
  return null;
}
