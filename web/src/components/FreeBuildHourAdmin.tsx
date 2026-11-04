"use client";

import { useEffect, useState } from "react";

type View = {
  freeBuildHourStart: string | null;
  freeBuildHourActiveUntil: string | null;
};

function toLocal(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

/** Schedule the free build hour: builds cost no credits for an hour from the start. */
export default function FreeBuildHourAdmin() {
  const [view, setView] = useState<View | null>(null);
  const [start, setStart] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin/platform")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: View | null) => {
        if (!d) return;
        setView(d);
        setStart(toLocal(d.freeBuildHourStart));
      });
  }, []);

  async function save(value: string | null) {
    setError("");
    const res = await fetch("/api/admin/platform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        freeBuildHourStart: value ? new Date(value).toISOString() : null,
      }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setError(d.error ?? "Couldn't save");
    setView(d);
    setStart(toLocal(d.freeBuildHourStart));
  }

  const muted = { color: "var(--muted)" };
  return (
    <section>
      <h2 className="text-sm font-medium">Free build hour</h2>
      <p className="mt-0.5 text-xs" style={muted}>
        For one hour from the start, builds cost no credits and run even on an
        empty balance. Everyone sees a banner with the end time.
      </p>
      {view?.freeBuildHourActiveUntil && (
        <p className="mt-2 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
          On now, until{" "}
          {new Date(view.freeBuildHourActiveUntil).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
          .
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <input
          type="datetime-local"
          aria-label="Free build hour start"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="rounded-lg border bg-transparent px-2.5 py-1.5 text-sm"
        />
        <button
          onClick={() => void save(start || null)}
          disabled={!start}
          className="rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          Schedule
        </button>
        <button
          onClick={() => void save(toLocal(new Date().toISOString()))}
          className="rounded-lg border px-3 py-1.5"
        >
          Start now
        </button>
        {view?.freeBuildHourStart && (
          <button
            onClick={() => void save(null)}
            className="text-xs text-red-600 hover:underline"
          >
            Turn off
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
