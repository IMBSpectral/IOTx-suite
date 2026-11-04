"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import Link from "next/link";

type Data = {
  email: string;
  improveForge: boolean;
  deletionScheduledAt: string | null;
  graceDays: number;
  impact: { deleted: { name: string; projects: number }[]; handedOver: string[] };
  sessions: { id: string; current: boolean; expires: string }[];
  devices: { name: string; at: string }[];
};

const card = "rounded-xl border p-4";
const muted = { color: "var(--muted)" };
const date = (s: string) => new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/** Settings → Privacy: data use, where you're signed in, and deleting the account. */
export default function PrivacyPanel() {
  const [data, setData] = useState<Data | null>(null);
  const brand = useBrand();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/account")
      .then((r) => r.json())
      .then((d) => live && setData(d))
      .catch(() => live && setError("Couldn't load privacy settings."));
    return () => {
      live = false;
    };
  }, [version]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) setError(d.error ?? "Something went wrong");
    setVersion((v) => v + 1);
    return res.ok;
  }

  if (!data) return <p className="text-sm" style={muted}>{error ?? "Loading privacy…"}</p>;
  const others = data.sessions.filter((s) => !s.current);

  return (
    <div className="space-y-8">
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium">Your data</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              Help improve {brand.name}
              <span className="block text-xs" style={muted}>
                Let {brand.name} use your projects and chats to improve its models. Off unless you turn it on; it never applies to
                secrets or environment variables.
              </span>
            </span>
            <input type="checkbox" checked={data.improveForge} disabled={busy} onChange={(e) => act({ action: "improveForge", on: e.target.checked })} />
          </label>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Where you&apos;re signed in</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <ul className="space-y-1.5 text-xs">
            {data.sessions.map((s, i) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span>
                  {s.current ? <b>This browser</b> : `Session ${i + 1}`}
                  <span style={muted}> · expires {date(s.expires)}</span>
                </span>
                {!s.current && (
                  <button disabled={busy} onClick={() => act({ action: "revokeSession", id: s.id })} className="rounded-md border px-2 py-0.5">
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
          {others.length > 1 && (
            <button disabled={busy} onClick={() => act({ action: "revokeOthers" })} className="mt-3 rounded-lg border px-2.5 py-1 text-xs">
              Sign out everywhere else
            </button>
          )}
          {data.devices.length > 0 && (
            <p className="mt-3 text-xs" style={muted}>
              Devices you approved: {data.devices.map((d) => `${d.name} (${date(d.at)})`).join(", ")}
            </p>
          )}
          <p className="mt-3 text-xs" style={muted}>
            Signing in on another device? It shows a code; enter it at <Link href="/device" className="underline">/device</Link> to approve it.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Delete account</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          {data.deletionScheduledAt ? (
            <div className="text-sm">
              <p>
                Your account will be deleted on <b>{date(data.deletionScheduledAt)}</b>.
              </p>
              <button disabled={busy} onClick={() => act({ action: "cancelDeletion" })} className="btn-primary mt-3 rounded-lg px-3 py-1.5 text-xs">
                Keep my account
              </button>
            </div>
          ) : (
            <div className="text-xs">
              <p style={muted}>
                Deletion is scheduled {data.graceDays} days out, so you can change your mind. Then it can&apos;t be undone.
              </p>
              {(data.impact.deleted.length > 0 || data.impact.handedOver.length > 0) && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4">
                  {data.impact.deleted.map((w) => (
                    <li key={w.name}>
                      <b>{w.name}</b> and its {w.projects} project{w.projects === 1 ? "" : "s"} will be deleted (you&apos;re its only member).
                    </li>
                  ))}
                  {data.impact.handedOver.map((n) => (
                    <li key={n}>
                      <b>{n}</b> passes to another admin or member.
                    </li>
                  ))}
                </ul>
              )}
              {asking ? (
                <form
                  className="mt-3 flex flex-wrap gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act({ action: "scheduleDeletion", confirm })) setAsking(false);
                  }}
                >
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder={data.email}
                    aria-label="Type your email to confirm"
                    className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5"
                  />
                  <button disabled={busy} className="rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">
                    Schedule deletion
                  </button>
                  <button type="button" onClick={() => setAsking(false)} className="rounded-lg border px-3 py-1.5">
                    Cancel
                  </button>
                </form>
              ) : (
                <button onClick={() => setAsking(true)} className="mt-3 rounded-lg border border-red-500/50 px-3 py-1.5 text-red-600 dark:text-red-400">
                  Delete my account…
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
