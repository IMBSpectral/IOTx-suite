"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import { useTabTitle } from "./tabs";
import { usePerms } from "./PermsProvider";

type Item = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  starred?: boolean;
  owners?: { displayName?: string }[];
};
type Status = { configured: boolean; connection: { email: string; canEdit: boolean } | null };

const FOLDER = "application/vnd.google-apps.folder";
/** Connecting Google is a full-page trip through Google sign-in (an API route, not a page). */
const CONNECT = `/api/google/connect?back=${encodeURIComponent("/gdrive")}`;
/** Google's own file types that open in the suite's Docs, Sheets and Slides. */
const SUITE: Record<string, string> = {
  "application/vnd.google-apps.document": "docs",
  "application/vnd.google-apps.spreadsheet": "sheets",
  "application/vnd.google-apps.presentation": "slides",
};
const VIEWS = [
  ["mine", "folder", "My Drive"],
  ["shared", "people", "Shared with me"],
  ["recent", "clock", "Recent"],
  ["starred", "pin", "Starred"],
] as const;

const bytes = (n?: string) => {
  const v = Number(n ?? 0);
  if (!v) return "—";
  return v >= 1e9 ? `${(v / 1e9).toFixed(1)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${Math.round(v / 1e3)} KB` : `${v} B`;
};
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
function iconFor(m: string) {
  if (m === FOLDER) return "folder";
  if (SUITE[m]) return SUITE[m];
  if (m === "application/pdf") return "docs";
  if (/sheet|excel|csv/.test(m)) return "sheets";
  return "files";
}

/**
 * Google Drive: the person's own Drive, through the Google account they connect (the same one
 * Docs, Sheets and Slides use). Browse My Drive, Shared with me, Recent and Starred, search the
 * whole Drive, open Google files in the suite, download, or copy a file into Files. Anything here
 * can be @-mentioned elsewhere in the suite, and the AI reads it.
 */
export default function GDriveApp({ initialFile }: { initialFile?: string }) {
  useTabTitle("Google Drive");
  const perms = usePerms();
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState("mine");
  const [folder, setFolder] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [crumbs, setCrumbs] = useState<{ id: string; name: string }[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState<Item | null>(null);

  useEffect(() => {
    void fetch("/api/gdrive?view=status", { cache: "no-store" })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connection: null }));
  }, []);

  const load = useCallback(
    async (page?: string) => {
      const q = new URLSearchParams({ view, ...(folder ? { folder } : {}), ...(search ? { q: search } : {}), ...(page ? { page } : {}) });
      const r = await fetch(`/api/gdrive?${q}`, { cache: "no-store" }).catch(() => null);
      const d = r ? await r.json().catch(() => null) : null;
      if (!r?.ok || !d) return setError(d?.error ?? "Couldn't load your Google Drive.");
      setError(null);
      setItems((cur) => (page && cur ? [...cur, ...d.files] : d.files));
      setCrumbs(d.crumbs ?? []);
      setNext(d.nextPageToken ?? null);
    },
    [view, folder, search],
  );
  useEffect(() => {
    if (!status?.connection) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [status, load]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  // Opened from a link (an @ reference, /gdrive?file=<id>).
  useEffect(() => {
    if (!initialFile || !status?.connection) return;
    void fetch(`/api/gdrive?item=${encodeURIComponent(initialFile)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { item?: Item } | null) => {
        if (!d?.item) return setError("That file isn't in your Google Drive, or it isn't shared with you.");
        if (d.item.mimeType === FOLDER) setFolder(d.item.id);
        else if (SUITE[d.item.mimeType]) window.location.assign(`/${SUITE[d.item.mimeType]}/${d.item.id}`);
        else setFocus(d.item);
      })
      .catch(() => undefined);
  }, [initialFile, status]);

  const open = (f: Item) => {
    if (f.mimeType === FOLDER) {
      setFolder(f.id);
      setTyped("");
      setSearch("");
    } else if (SUITE[f.mimeType]) window.location.assign(`/${SUITE[f.mimeType]}/${f.id}`);
    else setFocus(f);
  };
  const toFiles = async (f: Item) => {
    setBusy(f.id);
    const r = await fetch("/api/gdrive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "toFiles", id: f.id }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(null);
    setNote(r?.ok ? `${f.name} copied into Files (My files).` : (d.error ?? "Couldn't copy it."));
  };
  const go = (v: string) => {
    setView(v);
    setFolder(null);
    setTyped("");
    setSearch("");
  };

  const muted = { color: "var(--ix-muted)" };
  if (!status) return <div className="p-8 text-sm" style={muted}>Loading…</div>;
  if (!status.connection) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-12">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full text-white" style={{ background: "linear-gradient(135deg,#1a73e8,#34a853 55%,#fbbc04)" }}>
            <Icon name="gdrive" size={19} />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Google Drive</h1>
            <p className="text-sm" style={muted}>Your own Google Drive, inside the suite</p>
          </div>
        </div>
        <div className="rounded-xl border p-6" style={{ background: "var(--ix-panel)" }}>
          <h2 className="text-base font-semibold">Connect your Google account</h2>
          <p className="mt-1 text-sm" style={muted}>
            Browse and search your Drive here, open Google Docs, Sheets and Slides in the suite, download files or copy them into Files, and @-mention any of them in the Builder, AI chat, Mail or Tasks so the AI can read them. Only you see your Drive.
          </p>
          {status.configured ? (
            <a href={CONNECT} className="mt-4 inline-flex rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }}>
              Connect Google Drive
            </a>
          ) : (
            <p className="mt-4 text-sm text-amber-600">Google isn&rsquo;t set up on this server yet. Ask your platform admin.</p>
          )}
        </div>
      </div>
    );
  }

  const top = VIEWS.find((v) => v[0] === view)?.[2] ?? "My Drive";
  return (
    <div className="ix-files">
      <aside className="ix-files-nav">
        <div className="mb-2 px-2 text-xs" style={muted}>
          {status.connection.email}
        </div>
        {VIEWS.map(([v, icon, label]) => (
          <button key={v} type="button" className={`ix-files-tab ${view === v && !search ? "on" : ""}`} onClick={() => go(v)}>
            <Icon name={icon} size={16} /> {label}
          </button>
        ))}
        <div className="mt-3 flex flex-col gap-1 px-2 text-xs">
          <a className="underline" style={muted} href={CONNECT}>
            Use a different Google account
          </a>
          <a className="underline" style={muted} href="https://drive.google.com" target="_blank" rel="noreferrer">
            Open drive.google.com
          </a>
        </div>
      </aside>

      <main className="ix-files-main">
        <div className="ix-files-bar">
          <nav className="ix-files-crumbs" aria-label="Folder">
            <button type="button" onClick={() => setFolder(null)}>
              {search ? `Search: ${search}` : top}
            </button>
            {!search &&
              crumbs.map((c) => (
                <span key={c.id}>
                  ›
                  <button type="button" onClick={() => setFolder(c.id)}>
                    {c.name}
                  </button>
                </span>
              ))}
          </nav>
          <div className="ix-usage-search ix-files-search">
            <Icon name="search" size={15} />
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search your Google Drive" aria-label="Search Google Drive" />
          </div>
        </div>
        {error && <p className="ix-error">{error}</p>}
        <div className="ix-usage-tablewrap">
          <table className="ix-usage-table ix-files-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Modified</th>
                <th className="r">Size</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {items?.map((f) => (
                <tr key={f.id} onDoubleClick={() => open(f)}>
                  <td>
                    <button type="button" className="ix-files-name" onClick={() => open(f)}>
                      <span className={`ix-files-ico k-${f.mimeType === FOLDER ? "folder" : "file"}`}>
                        <Icon name={iconFor(f.mimeType)} size={15} />
                      </span>
                      {f.name}
                      {f.starred && <Icon name="pin" size={12} />}
                    </button>
                  </td>
                  <td className="dim">{f.owners?.[0]?.displayName ?? "—"}</td>
                  <td className="nowrap dim">{when(f.modifiedTime)}</td>
                  <td className="r mono dim">{f.mimeType === FOLDER || SUITE[f.mimeType] ? "—" : bytes(f.size)}</td>
                  <td className="r nowrap">
                    {f.mimeType !== FOLDER && (
                      <span className="ix-files-acts">
                        {perms.can("gdrive.copy") && (
                          <button type="button" className="ix-btn" disabled={busy === f.id} onClick={() => void toFiles(f)} title="Copy into Files (company storage)">
                            {busy === f.id ? "Copying…" : "Copy to Files"}
                          </button>
                        )}
                        {perms.can("gdrive.download") && (
                          <a className="ix-act" href={`/api/gdrive/${f.id}`} aria-label={`Download ${f.name}`} title="Download">
                            <Icon name="insert" size={15} />
                          </a>
                        )}
                        {f.webViewLink && (
                          <a className="ix-act" href={f.webViewLink} target="_blank" rel="noreferrer" aria-label={`Open ${f.name} in Google`} title="Open in Google">
                            <Icon name="link" size={15} />
                          </a>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {items && !items.length && (
                <tr>
                  <td colSpan={5} className="empty">
                    {search ? `Nothing in your Drive matches "${search}".` : "Nothing here."}
                  </td>
                </tr>
              )}
              {!items && !error && (
                <tr>
                  <td colSpan={5} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {next && (
          <button type="button" className="ix-btn" style={{ marginTop: 10 }} onClick={() => void load(next)}>
            Load more
          </button>
        )}
      </main>

      {focus && (
        <div className="ix-files-preview" role="dialog" aria-label={focus.name} onClick={() => setFocus(null)}>
          <div className="ix-files-pv" style={{ maxWidth: 520, height: "auto" }} onClick={(e) => e.stopPropagation()}>
            <header>
              <b>{focus.name}</b>
              <span className="dim">{bytes(focus.size)}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="ix-act" aria-label="Close" onClick={() => setFocus(null)}>
                <Icon name="close" size={16} />
              </button>
            </header>
            <div className="flex flex-wrap gap-2 p-4">
              {focus.webViewLink && (
                <a className="ix-btn primary" href={focus.webViewLink} target="_blank" rel="noreferrer">
                  Open in Google
                </a>
              )}
              {perms.can("gdrive.download") && (
                <a className="ix-btn" href={`/api/gdrive/${focus.id}`}>
                  Download
                </a>
              )}
              {perms.can("gdrive.copy") && (
                <button type="button" className="ix-btn" disabled={busy === focus.id} onClick={() => void toFiles(focus)}>
                  {busy === focus.id ? "Copying…" : "Copy to Files"}
                </button>
              )}
            </div>
            <p className="px-4 pb-4 text-xs" style={muted}>
              Modified {when(focus.modifiedTime)}. Type @ in the Builder, AI chat, Mail or Tasks and pick Google Drive to have the AI read this file.
            </p>
          </div>
        </div>
      )}
      {note && (
        <div className="ix-ppl-note" role="status">
          {note}
        </div>
      )}
    </div>
  );
}
