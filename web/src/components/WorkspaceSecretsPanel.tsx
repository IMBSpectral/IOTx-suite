"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";

/** Workspace secrets: API keys every project can use; a project secret of the same name overrides. */
export default function WorkspaceSecretsPanel() {
  const [secrets, setSecrets] = useState<{ name: string; updatedAt: string }[] | null>(null);
  const [form, setForm] = useState({ name: "", value: "" });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const muted = { color: "var(--muted)" };

  const load = useCallback(() => {
    fetch("/api/workspace/secrets")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can manage secrets.");
        setSecrets(d.secrets);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>, msg: string) {
    setError("");
    setNote("");
    const r = await fetch("/api/workspace/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "That didn't work");
      return false;
    }
    setNote(msg);
    load();
    return true;
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <KeyRound className="h-4 w-4" /> Workspace secrets
        </h2>
        <p className="mt-1 text-sm" style={muted}>
          API keys and tokens that every project in this workspace can use, in server functions, the agent&apos;s
          API calls and app email. A project secret with the same name overrides the workspace one. Values are
          encrypted and never shown again.
        </p>
      </div>
      {note && (
        <p className="text-sm text-emerald-600" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-500" role="alert">
          {error}
        </p>
      )}
      {secrets && (
        <ul className="divide-y rounded-xl border text-sm">
          {secrets.length === 0 && (
            <li className="px-4 py-3" style={muted}>
              No workspace secrets yet.
            </li>
          )}
          {secrets.map((s) => (
            <li key={s.name} className="flex items-center justify-between px-4 py-2.5">
              <span>
                <span className="font-mono">{s.name}</span>
                <span className="ml-2 text-xs" style={muted}>
                  updated {new Date(s.updatedAt).toLocaleString()}
                </span>
              </span>
              <button
                onClick={() => {
                  if (confirm(`Delete ${s.name}? Projects that rely on it lose access unless they have their own.`))
                    void post({ action: "delete", name: s.name }, `Deleted ${s.name}.`);
                }}
                aria-label={`Delete ${s.name}`}
                className="text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {secrets && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post({ action: "set", ...form }, `Saved ${form.name}.`).then((ok) => ok && setForm({ name: "", value: "" }));
          }}
        >
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
            placeholder="NAME"
            aria-label="Secret name"
            className="w-48 rounded-lg border bg-transparent px-3 py-2 font-mono text-sm"
          />
          <input
            type="password"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            placeholder="Value"
            aria-label="Secret value"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={!form.name || !form.value}
            className="rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            Save
          </button>
        </form>
      )}
    </div>
  );
}
