"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import { useTabTitle } from "./tabs";

type Share = {
  id: string;
  name: string;
  label: string;
  description: string | null;
  kind: "table" | "sheet";
  ref: string;
  openToAll: boolean;
  source: { id: string; name: string };
  mine: boolean;
  canManage: boolean;
  apps: { grantId: string; projectId: string; name: string; lastUsedAt: string | null }[];
  url: string;
};
type App = { id: string; name: string };

/**
 * Data Hub: share an app's table or linked sheet so other apps in the
 * workspace can read it, and connect apps to shared data. Reads go through
 * /api/hub/<name> with each app's own revocable key.
 */
export default function DataHub() {
  useTabTitle("Data Hub");
  const [shares, setShares] = useState<Share[] | null>(null);
  const [apps, setApps] = useState<App[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [keyShown, setKeyShown] = useState<{ share: string; app: string; key: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/datahub", { cache: "no-store" }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (!r?.ok || !d) return setError(d?.error ?? "Couldn't load the Data Hub.");
    setError(null);
    setShares(d.shares);
    setApps(d.apps);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const post = async (body: Record<string, unknown>, ok?: string) => {
    const r = await fetch("/api/datahub", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) {
      setNote(d.error ?? "That didn't work.");
      return null;
    }
    if (ok) setNote(ok);
    await load();
    return d;
  };
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  return (
    <div className="ix-hub">
      <header className="ix-ppl-head">
        <div>
          <h1>Data Hub</h1>
          <p>Let apps read each other&apos;s data: share a table or a linked sheet from one app, connect it in another. Read-only, and each app&apos;s access can be cut off any time.</p>
        </div>
        <button type="button" className="ix-btn primary" onClick={() => setAdding(true)}>
          <Icon name="add" size={14} /> Share data
        </button>
      </header>
      {note && (
        <div className="ix-ppl-note" role="status">
          {note}
        </div>
      )}
      {error && <p className="ix-error">{error}</p>}
      {shares && shares.length === 0 && (
        <div className="ix-card ix-org-empty">
          <h2>Nothing shared yet</h2>
          <p>Share a table from an app (for example the customer list in your Sales app) so a dashboard or another app can show it. In the Builder you can also just say &quot;use the customers from the Sales app&quot;.</p>
          <button type="button" className="ix-btn primary" onClick={() => setAdding(true)}>
            Share data
          </button>
        </div>
      )}
      <div className="ix-hub-grid">
        {shares?.map((s) => (
          <ShareCard key={s.id} s={s} apps={apps} post={post} onKey={setKeyShown} />
        ))}
      </div>
      <section className="ix-card ix-hub-how">
        <h2>How an app reads shared data</h2>
        <pre>{`const r = await fetch("/api/hub/customers?status=eq.active&limit=100", {
  headers: { "x-hub-key": "<this app's key>" },
});
const { rows } = await r.json();      // a table   ·   { values } for a sheet`}</pre>
        <p className="dim small">The Builder does this for you when you connect an app. Filters: column=eq.value, neq, gt, gte, lt, lte, like; order=column.desc; up to 1,000 rows a call.</p>
      </section>
      {adding && <ShareForm apps={apps} post={post} onClose={() => setAdding(false)} />}
      {keyShown && (
        <div className="ix-ppl-drawer" role="dialog" aria-label="Read key">
          <form onSubmit={(e) => e.preventDefault()}>
            <header>
              <b>Connected</b>
              <button type="button" className="ix-act" aria-label="Close" onClick={() => setKeyShown(null)}>
                <Icon name="close" size={15} />
              </button>
            </header>
            <p className="small">
              <b>{keyShown.app}</b> can now read <b>{keyShown.share}</b>. Its read key (the Builder adds it to the app for you):
            </p>
            <code className="ix-hub-key">{keyShown.key}</code>
            <p className="dim small">Anyone with this key can read this data, so keep it inside that app. Disconnect the app to cut it off.</p>
          </form>
        </div>
      )}
    </div>
  );
}

function ShareCard({ s, apps, post, onKey }: { s: Share; apps: App[]; post: (b: Record<string, unknown>, ok?: string) => Promise<Record<string, unknown> | null>; onKey: (k: { share: string; app: string; key: string }) => void }) {
  const [pick, setPick] = useState("");
  const [sure, setSure] = useState(false);
  const candidates = apps.filter((a) => a.id !== s.source.id && !s.apps.some((x) => x.projectId === a.id));
  return (
    <article className="ix-card ix-hub-card">
      <div className="ix-hub-top">
        <span className={`ix-hub-kind k-${s.kind}`}>
          <Icon name={s.kind === "sheet" ? "sheets" : "dashboard"} size={14} />
        </span>
        <div className="grow">
          <b>{s.label}</b>
          <code>{s.name}</code>
        </div>
        <span className={`ix-hub-open ${s.openToAll ? "on" : ""}`}>{s.openToAll ? "Any app" : "Chosen apps"}</span>
      </div>
      {s.description && <p className="small">{s.description}</p>}
      <p className="dim small">
        From <b>{s.source.name}</b> · {s.kind === "sheet" ? "linked Google Sheet" : `table ${s.ref}`}
      </p>
      <div className="ix-hub-apps">
        <small className="dim">Read by</small>
        {s.apps.length === 0 && <span className="dim small">No apps yet</span>}
        {s.apps.map((a) => (
          <span key={a.grantId} className="ix-hub-app" title={a.lastUsedAt ? `Last read ${new Date(a.lastUsedAt).toLocaleString()}` : "Not read yet"}>
            {a.name}
            <button type="button" aria-label={`Disconnect ${a.name}`} onClick={() => void post({ action: "disconnect", grantId: a.grantId }, `${a.name} disconnected.`)}>
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="ix-hub-connect">
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="App to connect">
          <option value="">Connect an app…</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ix-btn"
          disabled={!pick}
          onClick={async () => {
            const d = s.openToAll || !s.canManage ? await post({ action: "connect", id: s.id, projectId: pick }) : await post({ action: "update", id: s.id, allow: pick });
            if (d) {
              const k = (d.key as string | undefined) ?? null;
              if (k) onKey({ share: s.label, app: apps.find((a) => a.id === pick)?.name ?? "The app", key: k });
              setPick("");
            }
          }}
        >
          Connect
        </button>
      </div>
      {s.canManage && (
        <div className="ix-hub-own">
          <label className="ix-usage-all">
            <input type="checkbox" checked={s.openToAll} onChange={(e) => void post({ action: "update", id: s.id, openToAll: e.target.checked }, e.target.checked ? "Any app can connect now." : "Only apps you add can connect.")} /> Any app in the workspace can connect
          </label>
          {sure ? (
            <button type="button" className="ix-btn danger" onClick={() => void post({ action: "delete", id: s.id }, `"${s.name}" removed; every app is cut off.`)}>
              Remove: cuts off {s.apps.length} {s.apps.length === 1 ? "app" : "apps"}
            </button>
          ) : (
            <button type="button" className="ix-btn danger" onClick={() => setSure(true)}>
              Remove…
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function ShareForm({ apps, post, onClose }: { apps: App[]; post: (b: Record<string, unknown>, ok?: string) => Promise<Record<string, unknown> | null>; onClose: () => void }) {
  const [projectId, setProjectId] = useState("");
  const [opts, setOpts] = useState<{ tables: string[]; sheets: { id: string; name: string }[] } | null>(null);
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [openToAll, setOpenToAll] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    fetch(`/api/datahub?project=${projectId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (d.error) setError(d.error);
        else {
          setError(null);
          setOpts(d.shareable);
        }
      })
      .catch(() => live && setError("Couldn't read that app."));
    return () => {
      live = false;
    };
  }, [projectId]);

  return (
    <div className="ix-ppl-drawer" role="dialog" aria-label="Share data">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const at = pick.indexOf(":");
          if (await post({ action: "share", projectId, kind: pick.slice(0, at), ref: pick.slice(at + 1), name, label, description, openToAll }, `Shared as "${name}".`)) onClose();
        }}
      >
        <header>
          <b>Share data</b>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <label>
          From the app
          <select value={projectId} onChange={(e) => (setProjectId(e.target.value), setOpts(null), setPick(""))} required>
            <option value="">Choose an app</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {opts && (
          <label>
            Data
            <select
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                const n = e.target.value.startsWith("table:") ? e.target.value.slice(6) : opts.sheets.find((s) => `sheet:${s.id}` === e.target.value)?.name ?? "";
                if (!name) setName(n.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40));
                if (!label) setLabel(n);
              }}
              required
            >
              <option value="">Choose a table or sheet</option>
              {opts.tables.map((t) => (
                <option key={t} value={`table:${t}`}>
                  Table · {t}
                </option>
              ))}
              {opts.sheets.map((s) => (
                <option key={s.id} value={`sheet:${s.id}`}>
                  Sheet · {s.name}
                </option>
              ))}
            </select>
            {opts.tables.length === 0 && opts.sheets.length === 0 && <small>This app has no database tables or linked sheets yet.</small>}
          </label>
        )}
        <label>
          Name other apps use
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} pattern="[a-z][a-z0-9_\-]{1,39}" placeholder="customers" required />
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Customer list" />
        </label>
        <label>
          What it is (optional)
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Every active customer with GST number and city" />
        </label>
        <label className="ix-setup-check">
          <input type="checkbox" checked={openToAll} onChange={(e) => setOpenToAll(e.target.checked)} />
          <span>
            <b>Any app in the workspace can connect</b>
            <small>Off: only apps you add.</small>
          </span>
        </label>
        {error && <p className="ix-error">{error}</p>}
        <footer>
          <button type="submit" className="ix-btn primary" disabled={!projectId || !pick || !name}>
            Share
          </button>
          <button type="button" className="ix-btn" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </form>
    </div>
  );
}
