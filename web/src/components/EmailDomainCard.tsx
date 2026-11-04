"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Globe, Loader2 } from "lucide-react";

type Rec = { record: string; type: string; name: string; value: string; priority?: number; status: string; inDns?: boolean };
type Domain = { id: string; name: string; status: string; records: Rec[]; checkedAt: string | null };
type State = { domains: Domain[]; active: string | null; localPart: string };

const LABEL: Record<string, string> = { verified: "Verified", pending: "Checking…", not_started: "Waiting for DNS", failed: "Failed", temporary_failure: "Temporarily failing" };

/** Cloud → Email: send the app's emails from the company's own domain. */
export default function EmailDomainCard({ projectId, connected }: { projectId: string; connected: boolean }) {
  const base = `/api/projects/${projectId}/cloud`;
  const muted = { color: "var(--muted)" };
  const [s, setS] = useState<State | null>(null);
  const [name, setName] = useState("");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetch(`${base}?view=emailDomains`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: State | null) => {
        if (!d) return;
        setS(d);
        setLocal((l) => l || d.localPart);
      });
  }, [base]);
  useEffect(load, [load]);

  async function step(op: string, extra: Record<string, unknown>) {
    setBusy(`${op}:${String(extra.id ?? "")}`);
    setError(null);
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "emailDomain", op, ...extra }) });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) setError(d.error ?? "That didn't work");
    else if (op === "add") {
      setName("");
      setOpen(d.domain?.id ?? null);
    }
    load();
  }

  if (!s) return null;
  const active = s.domains.find((d) => d.id === s.active);
  return (
    <section aria-label="Sending domain" className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
      <p className="flex items-center gap-1.5 font-medium">
        <Globe className="h-4 w-4" /> Sending domain
      </p>
      <p className="mt-1 text-xs" style={muted}>
        {active ? (
          <>
            Emails sent through Resend go out from <span className="font-medium">{`${s.localPart}@${active.name}`}</span>.
          </>
        ) : (
          "Send the app's emails from your own domain instead of the provider's shared address. Add the domain, publish its DNS records, then verify."
        )}
      </p>
      {!connected && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">This needs your Resend API key as the RESEND_API_KEY secret.</p>}

      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void step("add", { domain: name.trim() });
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="mail.yourcompany.com" aria-label="Domain to send from" className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-sm" />
        <button disabled={!!busy || !name.trim()} className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50">
          {busy?.startsWith("add") ? "Adding…" : "Add domain"}
        </button>
      </form>
      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}

      {s.domains.length > 0 && (
        <ul className="mt-3 space-y-2">
          {s.domains.map((d) => (
            <li key={d.id} className="rounded-lg border p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.name}</span>
                <span className={d.status === "verified" ? "text-emerald-700" : d.status.includes("fail") ? "text-red-600" : "text-amber-700 dark:text-amber-400"}>{LABEL[d.status] ?? d.status}</span>
                {s.active === d.id && <span className="rounded-full border px-1.5">Sending</span>}
                <span className="ml-auto flex gap-1.5">
                  <button onClick={() => setOpen(open === d.id ? null : d.id)} className="underline">
                    {open === d.id ? "Hide records" : "DNS records"}
                  </button>
                  <button onClick={() => void step("check", { id: d.id })} disabled={!!busy} className="underline">
                    {busy === `check:${d.id}` ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Verify"}
                  </button>
                  {d.status === "verified" && s.active !== d.id && (
                    <button onClick={() => void step("activate", { id: d.id })} disabled={!!busy} className="underline">
                      Send from this
                    </button>
                  )}
                  {s.active === d.id && (
                    <button onClick={() => void step("activate", { id: null })} disabled={!!busy} className="underline">
                      Stop using
                    </button>
                  )}
                  <button onClick={() => confirm(`Remove ${d.name}?`) && void step("remove", { id: d.id })} disabled={!!busy} className="text-red-600 underline">
                    Remove
                  </button>
                </span>
              </div>
              {d.checkedAt && <p className="mt-0.5" style={muted}>Checked {new Date(d.checkedAt).toLocaleString()}</p>}
              {open === d.id && (
                <div className="mt-2 overflow-x-auto">
                  <p className="mb-1" style={muted}>Add these at your DNS host (where the domain is managed), then choose Verify. DNS changes can take a while to show.</p>
                  <table className="w-full text-left">
                    <thead style={muted}>
                      <tr>
                        <th className="pr-2 font-normal">Type</th>
                        <th className="pr-2 font-normal">Name</th>
                        <th className="pr-2 font-normal">Value</th>
                        <th className="font-normal">Status</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {d.records.map((r, i) => (
                        <tr key={i} className="align-top">
                          <td className="pr-2">{r.type}{r.priority != null ? ` ${r.priority}` : ""}</td>
                          <td className="pr-2">{r.name}</td>
                          <td className="max-w-[16rem] pr-2">
                            <span className="flex items-start gap-1">
                              <span className="break-all">{r.value}</span>
                              <button onClick={() => void navigator.clipboard?.writeText(r.value)} aria-label={`Copy ${r.type} value`} className="shrink-0">
                                <Copy className="h-3 w-3" />
                              </button>
                            </span>
                          </td>
                          <td className="font-sans">
                            {r.status === "verified" ? (
                              <span className="flex items-center gap-0.5 text-emerald-700">
                                <Check className="h-3 w-3" /> Verified
                              </span>
                            ) : r.inDns ? (
                              "Found in DNS, waiting for the provider"
                            ) : (
                              "Not found yet"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {active && (
        <form
          className="mt-3 flex items-center gap-1.5 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void step("activate", { localPart: local });
          }}
        >
          <label htmlFor="mail-local">Address</label>
          <input id="mail-local" value={local} onChange={(e) => setLocal(e.target.value)} className="w-28 rounded-lg border bg-transparent px-2 py-1" />
          <span style={muted}>@{active.name}</span>
          <button disabled={!!busy || local === s.localPart} className="rounded-lg border px-2 py-1 disabled:opacity-50">
            Save
          </button>
        </form>
      )}
    </section>
  );
}
