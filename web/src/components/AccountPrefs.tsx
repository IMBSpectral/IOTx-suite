"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Account = {
  prefs: { suggestions: "all" | "first" | "off"; sandboxDiagnostics: boolean };
  profile: { handle: string | null; name: string | null; public: boolean; linkedinUrl: string | null };
};

/** Account-wide preferences (stored on the account, so they follow you to any browser) and the public profile. */
export default function AccountPrefs() {
  const [acct, setAcct] = useState<Account | null>(null);
  const [handle, setHandle] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  const card = "space-y-3 rounded-xl border p-5";

  useEffect(() => {
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Account | null) => {
        if (!d) return;
        setAcct(d);
        setHandle(d.profile.handle ?? "");
        setLinkedin(d.profile.linkedinUrl ?? "");
      })
      .catch(() => undefined);
  }, []);

  async function post(body: Record<string, unknown>, msg: string) {
    setNote("");
    setError("");
    const r = await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "That didn't work");
      return false;
    }
    setNote(msg);
    return true;
  }

  if (!acct) return null;
  const savedHandle = acct.profile.handle;

  return (
    <>
      {(note || error) && (
        <p className={`text-xs ${error ? "text-red-500" : "text-emerald-600"}`} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      <section id="suggestions">
        <h2 className="mb-3 text-sm font-medium">Suggestions</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <p className="text-xs" style={muted}>
            Next-step ideas the agent offers under its reply, one click to send.
          </p>
          {(
            [
              ["all", "On all generations"],
              ["first", "On first generation only"],
              ["off", "Off"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="suggestions"
                checked={acct.prefs.suggestions === v}
                onChange={() =>
                  void post({ action: "prefs", suggestions: v }, `Suggestions: ${label.toLowerCase()}.`).then(
                    (ok) => ok && setAcct({ ...acct, prefs: { ...acct.prefs, suggestions: v } }),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section id="diagnostics">
        <h2 className="mb-3 text-sm font-medium">Sandbox diagnostics</h2>
        <label className={`${card} flex items-start justify-between gap-4`} style={{ background: "var(--panel)" }}>
          <span>
            <span className="block text-sm">Share preview diagnostics with support</span>
            <span className="block text-xs" style={muted}>
              When you contact support, the preview sandbox&apos;s recent logs are attached so problems can be found faster. Off by default.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Share preview diagnostics with support"
            checked={acct.prefs.sandboxDiagnostics}
            onChange={(e) => {
              const on = e.target.checked;
              void post({ action: "prefs", on }, on ? "Diagnostics will be attached to support requests." : "Diagnostics won't be shared.").then(
                (ok) => ok && setAcct({ ...acct, prefs: { ...acct.prefs, sandboxDiagnostics: on } }),
              );
            }}
            className="mt-1"
          />
        </label>
      </section>

      <section id="profile">
        <h2 className="mb-3 text-sm font-medium">Public profile</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm">Show my profile</span>
              <span className="block text-xs" style={muted}>
                Your name, username and the projects you made public.
                {savedHandle && acct.profile.public && (
                  <>
                    {" "}
                    <Link href={`/@${savedHandle}`} className="underline">
                      View profile
                    </Link>
                  </>
                )}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label="Show my profile"
              checked={acct.profile.public}
              onChange={(e) => {
                const on = e.target.checked;
                void post({ action: "profile", public: on }, on ? "Your profile is public." : "Your profile is private.").then(
                  (ok) => ok && setAcct({ ...acct, profile: { ...acct.profile, public: on } }),
                );
              }}
              className="mt-1"
            />
          </label>
          <form
            className="space-y-2 border-t pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void post({ action: "profile", handle, linkedinUrl: linkedin }, "Profile saved.").then(
                (ok) => ok && setAcct({ ...acct, profile: { ...acct.profile, handle: handle.replace(/^@/, "").toLowerCase() || null, linkedinUrl: linkedin || null } }),
              );
            }}
          >
            <label className="block text-xs">
              Username
              <div className="mt-1 flex items-center rounded-lg border px-2">
                <span style={muted}>@</span>
                <input value={handle} onChange={(e) => setHandle(e.target.value)} aria-label="Username" className="w-full bg-transparent px-1 py-2 text-sm outline-none" />
              </div>
            </label>
            <label className="block text-xs">
              LinkedIn
              <input
                value={linkedin}
                onChange={(e) => setLinkedin(e.target.value)}
                placeholder="https://www.linkedin.com/in/your-name"
                aria-label="LinkedIn profile"
                className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
              />
            </label>
            <div className="flex justify-end">
              <button className="rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ background: "var(--accent)" }}>
                Save profile
              </button>
            </div>
          </form>
        </div>
      </section>
    </>
  );
}
