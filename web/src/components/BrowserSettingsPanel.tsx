"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Settings = { enabled: boolean; anySite: boolean; allowed: string[]; idleMinutes: number };

/** Workspace settings for the agent's cloud browser. */
export default function BrowserSettingsPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const [sites, setSites] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    fetch("/api/workspace/browser")
      .then((r) => r.json())
      .then((d: Settings) => {
        setS(d);
        setSites(d.allowed.join("\n"));
      })
      .catch(() => undefined);
  }, []);

  async function save(patch: Partial<Settings>, msg = "Saved.") {
    setError("");
    setNote("");
    const r = await fetch("/api/workspace/browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "Only workspace owners and admins can change this.");
    setS(d);
    setSites(d.allowed.join("\n"));
    setNote(msg);
  }

  if (!s) return null;
  return (
    <div className="space-y-5 text-sm">
      <div>
        <h2 className="text-base font-semibold">Cloud browser</h2>
        <p className="mt-1" style={muted}>
          A real browser the agent can use for you, shown live in each project&apos;s Browser tab, where anyone working on the
          project can take over. It can only reach public websites.{" "}
          <Link href="/vault" className="underline">
            Your saved logins
          </Link>
        </p>
      </div>
      {(note || error) && (
        <p className={error ? "text-red-500" : "text-emerald-600"} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      <div className="space-y-3 rounded-xl border p-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? "The cloud browser is on." : "The cloud browser is off; open sessions were closed.")} />
          Let the agent use a cloud browser
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.anySite} disabled={!s.enabled} onChange={(e) => void save({ anySite: e.target.checked })} />
          Open any site without asking
        </label>
        <label className="block">
          <span className="text-xs" style={muted}>
            Allowed sites (one per line). Others need approval on a card, once, for an hour, or always.
          </span>
          <textarea value={sites} onChange={(e) => setSites(e.target.value)} rows={4} disabled={!s.enabled || s.anySite} aria-label="Allowed sites" className="mt-1 w-full rounded-lg border bg-transparent p-2 font-mono text-xs" />
        </label>
        <div className="flex items-center gap-2">
          <span>Close after</span>
          <select value={s.idleMinutes} onChange={(e) => void save({ idleMinutes: Number(e.target.value) })} aria-label="Idle limit" className="rounded-lg border bg-transparent px-2 py-1 text-xs">
            {[5, 10, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes idle
              </option>
            ))}
          </select>
          <button onClick={() => void save({ allowed: sites.split(/\s+/).filter(Boolean) }, "Allowed sites saved.")} className="ml-auto rounded-lg border px-3 py-1.5 text-xs">
            Save sites
          </button>
        </div>
      </div>
    </div>
  );
}
