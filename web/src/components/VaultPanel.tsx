"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { Trash2 } from "lucide-react";

type Login = { id: string; site: string; username: string; createdAt: string };

/** Saved logins for the agent's cloud browser. The password is only typed into the site by Forge. */
export default function VaultPanel({ site }: { site?: string }) {
  const [logins, setLogins] = useState<Login[] | null>(null);
  const brand = useBrand();
  const [form, setForm] = useState({ site: site ?? "", username: "", password: "" });
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    fetch("/api/account/vault")
      .then((r) => r.json())
      .then((d) => setLogins(d.logins ?? []))
      .catch(() => undefined);
  }, []);

  async function post(body: Record<string, unknown>, msg: string) {
    setError("");
    setNote("");
    const r = await fetch("/api/account/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "That didn't work");
    setLogins(d.logins);
    setNote(msg);
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-5 px-6 py-12 text-sm">
      <div>
        <h1 className="text-xl font-semibold">Saved logins</h1>
        <p className="mt-1" style={muted}>
          For the agent&apos;s cloud browser. {brand.shortName} types the password into the site&apos;s login form itself; the AI never sees it.
          Passwords are encrypted and can&apos;t be shown again.
        </p>
      </div>
      {(note || error) && (
        <p className={error ? "text-red-500" : "text-emerald-600"} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      <form
        className="space-y-2 rounded-xl border p-4"
        style={{ background: "var(--panel)" }}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void post({ action: "save", ...form }, `Saved. The agent can sign in to ${form.site} now.`).then(() => setForm({ site: "", username: "", password: "" }));
        }}
      >
        <input value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} placeholder="Site, e.g. app.example.com" aria-label="Site" className="w-full rounded-lg border bg-transparent px-3 py-2" />
        <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="Username or email" aria-label="Username or email" className="w-full rounded-lg border bg-transparent px-3 py-2" />
        <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Password" aria-label="Password" autoComplete="new-password" className="w-full rounded-lg border bg-transparent px-3 py-2" />
        <button className="w-full rounded-lg px-3 py-2 font-medium text-white" style={{ background: "var(--accent)" }}>
          Save login
        </button>
      </form>
      <ul className="divide-y rounded-xl border">
        {logins?.length === 0 && (
          <li className="px-4 py-3" style={muted}>
            No saved logins.
          </li>
        )}
        {logins?.map((l) => (
          <li key={l.id} className="flex items-center justify-between px-4 py-2.5">
            <span>
              <span className="font-medium">{l.site}</span> <span style={muted}>· {l.username}</span>
            </span>
            <button onClick={() => void post({ action: "delete", id: l.id }, "Login removed.")} aria-label={`Remove login for ${l.site}`} className="text-red-500">
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
