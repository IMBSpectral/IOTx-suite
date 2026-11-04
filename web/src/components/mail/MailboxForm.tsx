"use client";

import { useState } from "react";
import { PROVIDERS, providerById } from "@/lib/mail/providers";

export type Member = { id: string; name: string | null; email: string | null };

/**
 * Connect a mailbox: address, password (or app password), provider picked
 * from the address's mail servers, optional server settings. Admins can also
 * add a shared mailbox or one for a colleague. The connection is tested
 * before it's saved.
 */
export default function MailboxForm({
  admin,
  members = [],
  onDone,
  onCancel,
}: {
  admin?: boolean;
  members?: Member[];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [scope, setScope] = useState<"mine" | "shared" | "person">(admin ? "shared" : "mine");
  const [ownerId, setOwnerId] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [provider, setProvider] = useState("auto");
  const [detected, setDetected] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [srv, setSrv] = useState({ imapHost: "", imapPort: "", smtpHost: "", smtpPort: "", username: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effective = provider === "auto" ? detected ?? "custom" : provider;
  const preset = providerById(effective);

  async function detect() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    const r = await fetch("/api/mail/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "detect", email }) });
    const d = await r.json().catch(() => ({}));
    if (d.provider) {
      setDetected(d.provider);
      if (d.provider === "custom") setAdvanced(true);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const num = (v: string) => (v ? Number(v) : undefined);
    const res = await fetch("/api/mail/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scope,
        ownerId: scope === "person" ? ownerId : undefined,
        email,
        displayName,
        password,
        provider: effective,
        imapHost: srv.imapHost || undefined,
        imapPort: num(srv.imapPort),
        smtpHost: srv.smtpHost || undefined,
        smtpPort: num(srv.smtpPort),
        username: srv.username || undefined,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(d.error ?? "Couldn't connect this mailbox.");
      return;
    }
    onDone();
  }

  const field = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm";
  const label = "block text-sm font-medium";

  return (
    <form onSubmit={submit} className="space-y-4">
      {admin && (
        <fieldset className="flex flex-wrap gap-2" aria-label="Whose mailbox">
          {(
            [
              ["shared", "Shared mailbox", "e.g. sales@, accounts@"],
              ["person", "For a colleague", "Their personal mailbox"],
              ["mine", "My own", "Only you see it"],
            ] as const
          ).map(([v, t, s]) => (
            <label key={v} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${scope === v ? "border-[var(--accent)]" : ""}`} style={scope === v ? { background: "var(--accent-soft)" } : undefined}>
              <input type="radio" name="scope" value={v} checked={scope === v} onChange={() => setScope(v)} className="sr-only" />
              <b className="block">{t}</b>
              <span className="text-xs" style={{ color: "var(--ix-muted, var(--muted))" }}>{s}</span>
            </label>
          ))}
        </fieldset>
      )}
      {scope === "person" && (
        <label className={label}>
          Colleague
          <select required className={`${field} mt-1.5`} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Choose…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name ? `${m.name} (${m.email})` : m.email}</option>
            ))}
          </select>
        </label>
      )}
      <div className="rounded-lg border p-3">
        <a
          href={scope === "person" && !ownerId ? undefined : `/api/mail/google?${new URLSearchParams({ scope, ...(scope === "person" ? { ownerId } : {}), back: admin ? "/settings/mailboxes" : "/mail" })}`}
          aria-disabled={scope === "person" && !ownerId}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${scope === "person" && !ownerId ? "pointer-events-none opacity-50" : ""}`}
          style={{ background: "var(--ix-panel, var(--panel))" }}
        >
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          Sign in with Google
        </a>
        <p className="mt-1.5 text-xs" style={{ color: "var(--ix-muted, var(--muted))" }}>
          Best for Gmail and Google Workspace: no app password needed.{scope !== "mine" ? " On Google's screen, sign in as the mailbox you're connecting." : ""}
        </p>
      </div>
      <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--ix-muted, var(--muted))" }}>Or connect with a password (Zoho, Hostinger, Outlook and others)</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>
          Email address
          <input required type="email" autoComplete="off" className={`${field} mt-1.5`} value={email} onChange={(e) => setEmail(e.target.value)} onBlur={detect} placeholder="sales@yourcompany.com" />
        </label>
        <label className={label}>
          Name shown to recipients <span className="font-normal" style={{ color: "var(--ix-muted, var(--muted))" }}>(optional)</span>
          <input className={`${field} mt-1.5`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Sales · Industrial Forge" />
        </label>
      </div>
      <label className={label}>
        Provider
        <select className={`${field} mt-1.5`} value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="auto">{detected ? `Detected: ${providerById(detected).label}` : "Detect from the address"}</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label className={label}>
        Password
        <input required type="password" autoComplete="new-password" className={`${field} mt-1.5`} value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="mt-1 block text-xs font-normal" style={{ color: "var(--ix-muted, var(--muted))" }}>{preset.hint}</span>
      </label>

      <button type="button" className="text-sm underline" onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "Hide server settings" : "Server settings"}
      </button>
      {advanced && (
        <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
          {(
            [
              ["imapHost", "IMAP server (reading)", preset.imapHost || "imap.example.com"],
              ["imapPort", "IMAP port", String(preset.imapPort)],
              ["smtpHost", "SMTP server (sending)", preset.smtpHost || "smtp.example.com"],
              ["smtpPort", "SMTP port", String(preset.smtpPort)],
              ["username", "Sign-in name, if not the address", email || "same as the address"],
            ] as const
          ).map(([k, l, ph]) => (
            <label key={k} className="text-xs font-medium">
              {l}
              <input className={`${field} mt-1`} value={srv[k]} placeholder={ph} onChange={(e) => setSrv((s) => ({ ...s, [k]: e.target.value }))} />
            </label>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ background: "var(--accent)" }}>
          {busy ? "Checking the connection…" : "Connect mailbox"}
        </button>
        {onCancel && (
          <button type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
