"use client";
import { useState } from "react";
import { MessagesSquare } from "lucide-react";

type Invite = { email: string; name: string; channels: string[]; inviter: string; returning: boolean };

/** A guest's join page (from their link), or the "send me a new link" form. */
export default function GuestJoin({ token, invite, signedOut = false }: { token: string; invite: Invite | null; signedOut?: boolean }) {
  const [name, setName] = useState(invite?.name || "");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const post = async (b: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    const r = await fetch("/workspace/api/chat/guest-auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    setBusy(false);
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong.");
  };
  const join = (e: React.FormEvent) => {
    e.preventDefault();
    post({ token, name, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
      .then(() => window.location.replace("/workspace/chat"))
      .catch((x: Error) => setError(x.message));
  };
  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    post({ email })
      .then(() => setSent(true))
      .catch((x: Error) => setError(x.message));
  };

  return (
    <div className="ws-center">
      <div className="gj-card">
        <span className="gf-mark big"><MessagesSquare size={22} /></span>
        {invite ? (
          <form onSubmit={join} className="gj-form">
            <h1>{invite.returning ? "Welcome back" : `${invite.inviter} invited you to chat`}</h1>
            <p>
              As a guest you can read and post in {invite.channels.map((c) => `#${c}`).join(", ")}.
            </p>
            <label className="ws-field">
              <span>Your name</span>
              <input className="ws-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
            </label>
            <small className="ws-muted">Signing in as {invite.email}</small>
            {error && <p className="ws-error">{error}</p>}
            <button className="ws-btn primary" disabled={busy || !name.trim()}>{invite.returning ? "Open Chat" : "Join"}</button>
          </form>
        ) : sent ? (
          <div className="gj-form">
            <h1>Check your email</h1>
            <p>If {email} is a guest here, a new sign-in link is on its way. It works once and for 7 days.</p>
          </div>
        ) : (
          <form onSubmit={ask} className="gj-form">
            <h1>{signedOut ? "You're signed out" : token ? "This link has expired" : "Chat for guests"}</h1>
            <p>{token ? "Links work once and for 7 days. " : ""}Type the email you were invited with and we&apos;ll send a new sign-in link.</p>
            <input className="ws-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus aria-label="Email" />
            {error && <p className="ws-error">{error}</p>}
            <button className="ws-btn primary" disabled={busy || !email.trim()}>Email me a link</button>
          </form>
        )}
      </div>
    </div>
  );
}
