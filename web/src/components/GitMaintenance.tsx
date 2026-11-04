"use client";

import { useCallback, useEffect, useState } from "react";

type Branch = { name: string; draft: { name: string; status: string } | null; lastCommit: { message: string; at: string; author: string }; stale: boolean };

/** Git maintenance: branches, large files in history, and a history clean-up. */
export default function GitMaintenance({ projectId }: { projectId: string }) {
  const base = `/api/projects/${projectId}/git`;
  const [list, setList] = useState<Branch[] | null>(null);
  const [projectName, setProjectName] = useState("");
  const [large, setLarge] = useState<{ path: string; bytes: number; inCurrent: boolean }[] | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const muted = { color: "var(--muted)" };

  const load = useCallback(() => {
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setList(d.branches);
        setProjectName(d.projectName);
      })
      .catch(() => undefined);
  }, [base]);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>) {
    setError("");
    setNote("");
    setBusy(true);
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "That didn't work");
    if (d.removedObjects !== undefined) setNote(`History cleaned up: ${d.before} versions became 1; ${d.removedObjects} old objects removed.`);
    else setNote("Branch deleted.");
    setLarge(null);
    load();
  }

  if (!list) return null;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return (
    <section aria-label="Git maintenance" className="space-y-3">
      <h3 className="text-sm font-medium">Git maintenance</h3>
      {(note || error) && (
        <p className={`text-xs ${error ? "text-red-500" : "text-emerald-600"}`} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      <ul className="divide-y rounded-lg border text-xs">
        {list.map((b) => (
          <li key={b.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="font-mono">{b.name}</span>
              {b.draft && <span style={muted}> · draft “{b.draft.name}” ({b.draft.status.toLowerCase()})</span>}
              <span className="block truncate" style={muted}>
                {b.lastCommit.message} · {b.lastCommit.author} · {new Date(b.lastCommit.at).toLocaleString()}
              </span>
            </span>
            {b.stale && (
              <button disabled={busy} onClick={() => void post({ action: "deleteBranch", name: b.name })} className="rounded-md border px-2 py-0.5 text-red-500">
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="space-y-2 rounded-lg border p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="flex-1">Large files in history</span>
          <button onClick={() => fetch(`${base}?large=1`).then((r) => r.json()).then((d) => setLarge(d.files ?? []))} className="rounded-md border px-2 py-0.5">
            Find
          </button>
        </div>
        {large && (large.length === 0 ? <p style={muted}>No files over 1 MB.</p> : (
          <ul>
            {large.map((f) => (
              <li key={f.path + f.bytes}>
                {mb(f.bytes)} · <span className="font-mono">{f.path}</span> {f.inCurrent ? "" : <span style={muted}>(deleted since)</span>}
              </li>
            ))}
          </ul>
        ))}
        <p style={muted}>
          Cleaning up history starts it again from the current version: every old version, finished draft and file not in
          the current version (deleted or large) is removed for good. Published sites keep working.
        </p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post({ action: "cleanHistory", confirm: confirmText });
          }}
        >
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={`Type ${projectName} to confirm`} aria-label="Type the project name to confirm" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1" />
          <button disabled={busy || confirmText.trim() !== projectName.trim()} className="rounded-md bg-red-600 px-2.5 py-1 font-medium text-white disabled:opacity-40">
            Clean up history
          </button>
        </form>
      </div>
    </section>
  );
}
