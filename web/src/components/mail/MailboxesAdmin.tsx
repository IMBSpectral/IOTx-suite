"use client";

import { useCallback, useEffect, useState } from "react";
import MailboxForm, { type Member } from "./MailboxForm";

type Box = {
  id: string;
  authType: string;
  email: string;
  displayName: string | null;
  provider: string;
  ownerId: string | null;
  sharedWith: string[];
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
};

/** Settings → Mailboxes: every mailbox in the workspace, for mailbox admins. */
export default function MailboxesAdmin() {
  const [data, setData] = useState<{ all?: Box[]; members?: Member[]; isAdmin?: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("mail") === "connected") setMsg({ ok: true, text: "Mailbox connected with Google. Mail starts syncing within a few minutes." });
    else if (p.get("mail_error")) setMsg({ ok: false, text: p.get("mail_error")! });
  }, []);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => fetch("/api/mail/mailboxes").then((r) => r.json()).then(setData), []);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>, ok: string) {
    setMsg(null);
    const r = await fetch("/api/mail/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: d.error ?? "That didn't work." });
    if (r.ok) await load();
    return r.ok;
  }

  if (!data) return null;
  if (!data.isAdmin)
    return (
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        Managing company mailboxes needs the &ldquo;Manage company mailboxes&rdquo; permission. You can still connect your own mailbox in Mail.
      </p>
    );

  const members = data.members ?? [];
  const nameOf = (id: string | null) => {
    const m = members.find((x) => x.id === id);
    return m ? m.name ?? m.email ?? "Someone" : "Someone";
  };
  const boxes = data.all ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Mailboxes</h2>
          <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--muted)" }}>
            Connect shared mailboxes like sales@ and accounts@ and choose who uses them, or set up a colleague&rsquo;s mailbox for them. Everyone can also connect their own mailbox from Mail. Mail is read and sent through each mailbox&rsquo;s own servers; passwords are stored encrypted.
          </p>
        </div>
        {!adding && (
          <button type="button" className="rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} onClick={() => setAdding(true)}>
            Add mailbox
          </button>
        )}
      </div>

      {adding && (
        <section className="rounded-xl border p-5" style={{ background: "var(--panel)" }}>
          <MailboxForm
            admin
            members={members}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false);
              setMsg({ ok: true, text: "Mailbox connected. Mail starts syncing within a few minutes." });
              void load();
            }}
          />
        </section>
      )}

      {msg && <p role="status" className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-500"}`}>{msg.text}</p>}

      <div className="overflow-x-auto rounded-xl border" style={{ background: "var(--panel)" }}>
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              <th className="px-4 py-2.5 font-medium">Mailbox</th>
              <th className="px-4 py-2.5 font-medium">Used by</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {boxes.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center" style={{ color: "var(--muted)" }}>
                  No mailboxes yet. Add a shared one, or connect one for a colleague.
                </td>
              </tr>
            )}
            {boxes.map((b) => (
              <tr key={b.id} className="border-t align-top">
                <td className="px-4 py-3">
                  <b className="block">{b.email}</b>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>{b.displayName ?? "—"} · {b.authType === "gmail" ? "Signed in with Google" : b.provider}</span>
                </td>
                <td className="px-4 py-3">
                  {b.ownerId ? (
                    <>Personal · {nameOf(b.ownerId)}</>
                  ) : (
                    <>
                      Shared · {b.sharedWith.length ? b.sharedWith.map(nameOf).join(", ") : <i>nobody yet</i>}
                    </>
                  )}
                  {sharing === b.id && (
                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                      {members.map((m) => (
                        <label key={m.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={b.sharedWith.includes(m.id)}
                            onChange={(e) => {
                              const next = e.target.checked ? [...b.sharedWith, m.id] : b.sharedWith.filter((x) => x !== m.id);
                              void post({ action: "share", id: b.id, userIds: next }, "Access updated.");
                            }}
                          />
                          {m.name ?? m.email}
                        </label>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${b.status === "ok" ? "bg-emerald-100 text-emerald-800" : b.status === "error" ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-700"}`}>
                    {b.status === "ok" ? "Working" : b.status === "error" ? "Sign-in failing" : "New"}
                  </span>
                  <span className="mt-1 block text-xs" style={{ color: "var(--muted)" }}>
                    {b.lastSyncAt ? `Synced ${new Date(b.lastSyncAt).toLocaleString()}` : "Not synced yet"}
                  </span>
                  {b.status === "error" && b.lastError && <span className="mt-1 block text-xs text-red-500">{b.lastError}</span>}
                  {editing === b.id && (
                    <div className="mt-2 flex gap-2">
                      <input type="password" placeholder="New password" className="w-40 rounded-lg border bg-transparent px-2 py-1 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
                      <button
                        type="button"
                        className="rounded-lg border px-2 py-1 text-sm"
                        onClick={async () => {
                          if (await post({ action: "update", id: b.id, password }, "Password updated and tested.")) {
                            setEditing(null);
                            setPassword("");
                          }
                        }}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {!b.ownerId && (
                      <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setSharing(sharing === b.id ? null : b.id)}>
                        {sharing === b.id ? "Done" : "Choose people"}
                      </button>
                    )}
                    {b.authType === "gmail" ? (
                      <a
                        className="rounded-lg border px-2 py-1 text-xs"
                        href={`/api/mail/google?${new URLSearchParams({ scope: b.ownerId ? "person" : "shared", ...(b.ownerId ? { ownerId: b.ownerId } : {}), back: "/settings/mailboxes" })}`}
                      >
                        Reconnect with Google
                      </a>
                    ) : (
                      <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setEditing(editing === b.id ? null : b.id)}>
                        Update password
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded-lg border px-2 py-1 text-xs text-red-600"
                      onClick={() => {
                        if (confirmRemove !== b.id) return setConfirmRemove(b.id);
                        setConfirmRemove(null);
                        void post({ action: "remove", id: b.id }, `${b.email} disconnected. Its mail stays on the provider's servers.`);
                      }}
                    >
                      {confirmRemove === b.id ? "Click again to disconnect" : "Disconnect"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
