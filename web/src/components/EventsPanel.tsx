"use client";

import { useCallback, useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { Send, Trash2 } from "lucide-react";

const EVENTS = [
  "member.invited",
  "member.removed",
  "project.published",
  "project.unpublished",
  "project.shared",
  "project.unshared",
  "project.sharing",
  "connector.connected",
  "connector.disconnected",
  "workspace.settings",
  "workspace.secret",
  "rules.changed",
  "domain.added",
  "domain.verified",
  "domain.removed",
  "device.approved",
  "session.revoked",
];

type Last = { at: string; status: number | null; error?: string };
type Dest = { id: string; url: string; events: string[]; secret: string; enabled: boolean; last?: Last };
type Hook = { id: string; url: string; action: string; secret: string; onError: "allow" | "deny"; last?: Last };

/** Event destinations (webhooks for workspace events) and check hooks that can stop a publish. */
export default function EventsPanel() {
  const brand = useBrand();
  const [data, setData] = useState<{ destinations: Dest[]; hooks: Hook[]; log: { at: string; to: string; event: string; status: number | null }[] } | null>(null);
  const [dest, setDest] = useState({ url: "", events: ["*"] as string[] });
  const [hook, setHook] = useState({ url: "", onError: "deny" });
  const [secret, setSecret] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  const inputCls = "min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm";

  const load = useCallback(() => {
    fetch("/api/workspace/events")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can manage event destinations.");
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>) {
    setError("");
    setNote("");
    const r = await fetch("/api/workspace/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "That didn't work");
      return null;
    }
    load();
    return d;
  }

  const lastText = (l?: Last) => (!l ? "never called" : `${l.status ?? "no answer"} · ${new Date(l.at).toLocaleString()}${l.error ? ` · ${l.error}` : ""}`);

  return (
    <div className="space-y-6 text-sm">
      <div>
        <h2 className="text-base font-semibold">Events</h2>
        <p className="mt-1" style={muted}>
          Send this workspace&apos;s events (members, sharing, publishing, connectors, security settings) to your own
          HTTPS endpoints as they happen. Each request is signed: check <code>x-forge-signature</code> = sha256 HMAC of{" "}
          <code>{"{timestamp}.{body}"}</code> with the endpoint&apos;s secret.
        </p>
      </div>
      {secret && (
        <div className="rounded-xl border border-emerald-500/40 p-3" role="status">
          <p className="font-medium">Signing secret (shown once)</p>
          <code className="mt-1 block break-all font-mono text-xs">{secret}</code>
        </div>
      )}
      {(note || error) && (
        <p className={error ? "text-red-500" : "text-emerald-600"} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      {data && (
        <>
          <section className="space-y-2">
            <h3 className="font-medium">Event destinations</h3>
            <ul className="divide-y rounded-xl border">
              {data.destinations.length === 0 && (
                <li className="px-4 py-3" style={muted}>
                  None yet.
                </li>
              )}
              {data.destinations.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{d.url}</span>
                    <span className="block text-xs" style={muted}>
                      {d.events.includes("*") ? "All events" : d.events.join(", ")} · {lastText(d.last)}
                    </span>
                  </span>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={d.enabled} onChange={(e) => void post({ action: "toggle", id: d.id, enabled: e.target.checked })} /> On
                  </label>
                  <button onClick={async () => {
                    const r = await post({ action: "test", id: d.id });
                    if (r) setNote(r.status ? `Test sent: the endpoint answered ${r.status}.` : `Test failed: ${r.error}`);
                  }} className="rounded-lg border px-2 py-1 text-xs">
                    <Send className="inline h-3 w-3" /> Test
                  </button>
                  <button onClick={() => void post({ action: "remove", id: d.id })} aria-label="Remove destination" className="text-red-500">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="space-y-2 rounded-xl border p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await post({ action: "addDestination", ...dest });
                if (r) {
                  setSecret(r.secret);
                  setDest({ url: "", events: ["*"] });
                }
              }}
            >
              <div className="flex gap-2">
                <input value={dest.url} onChange={(e) => setDest({ ...dest, url: e.target.value })} placeholder="https://example.com/forge-events" aria-label="Endpoint URL" className={inputCls} />
                <button className="rounded-lg px-3 py-2 font-medium text-white" style={{ background: "var(--accent)" }}>
                  Add
                </button>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer" style={muted}>
                  {dest.events.includes("*") ? "All events" : `${dest.events.length} event types`}
                </summary>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={dest.events.includes("*")} onChange={(e) => setDest({ ...dest, events: e.target.checked ? ["*"] : [] })} /> All events
                  </label>
                  {EVENTS.map((ev) => (
                    <label key={ev} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={dest.events.includes("*")}
                        checked={dest.events.includes("*") || dest.events.includes(ev)}
                        onChange={(e) => setDest({ ...dest, events: e.target.checked ? [...dest.events, ev] : dest.events.filter((x) => x !== ev) })}
                      />
                      <code>{ev}</code>
                    </label>
                  ))}
                </div>
              </details>
            </form>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Check hooks</h3>
            <p className="text-xs" style={muted}>
              Before anyone publishes, {brand.shortName} asks each hook. Answer <code>{'{"allow": true}'}</code> to let it continue, or{" "}
              <code>{'{"allow": false, "reason": "…"}'}</code> to stop it (the reason is shown to the person publishing).
            </p>
            <ul className="divide-y rounded-xl border">
              {data.hooks.length === 0 && (
                <li className="px-4 py-3" style={muted}>
                  None yet.
                </li>
              )}
              {data.hooks.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{h.url}</span>
                    <span className="block text-xs" style={muted}>
                      Before publishing · if it can&apos;t be reached: {h.onError === "deny" ? "stop" : "continue"} · {lastText(h.last)}
                    </span>
                  </span>
                  <button onClick={() => void post({ action: "remove", id: h.id })} aria-label="Remove hook" className="text-red-500">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="flex flex-wrap gap-2 rounded-xl border p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await post({ action: "addHook", ...hook });
                if (r) {
                  setSecret(r.secret);
                  setHook({ url: "", onError: "deny" });
                }
              }}
            >
              <input value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} placeholder="https://example.com/forge-check" aria-label="Check hook URL" className={inputCls} />
              <select value={hook.onError} onChange={(e) => setHook({ ...hook, onError: e.target.value })} aria-label="If the hook can't be reached" className="rounded-lg border bg-transparent px-2 py-2 text-xs">
                <option value="deny">If unreachable: stop</option>
                <option value="allow">If unreachable: continue</option>
              </select>
              <button className="rounded-lg px-3 py-2 font-medium text-white" style={{ background: "var(--accent)" }}>
                Add hook
              </button>
            </form>
          </section>

          {data.log.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-medium">Recent deliveries</h3>
              <ul className="divide-y rounded-xl border text-xs">
                {data.log.slice(0, 20).map((l, i) => (
                  <li key={i} className="flex gap-3 px-4 py-1.5">
                    <span className={l.status && l.status < 300 ? "text-emerald-600" : "text-red-500"}>{l.status ?? "—"}</span>
                    <code>{l.event}</code>
                    <span className="truncate" style={muted}>
                      {l.to}
                    </span>
                    <span className="ml-auto shrink-0" style={muted}>
                      {new Date(l.at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
