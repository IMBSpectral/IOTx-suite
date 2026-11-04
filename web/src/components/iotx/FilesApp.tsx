"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { useTabTitle } from "./tabs";

type FItem = { id: string; kind: "file" | "folder"; name: string; size: number; mime: string | null; parentId: string | null; ownerId: string; ownerName: string | null; updatedAt: string; trashedAt: string | null; access: "owner" | "edit" | "view"; shared: number };
type Usage = { used: number; limit: number; companyUsed: number; companyLimit: number | null };
type List = { view: string; folder: string | null; access: "owner" | "edit" | "view"; crumbs: { id: string; name: string }[]; items: FItem[]; usage: Usage };
type Member = { userId: string; name: string | null; email: string };

const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const when = (s: string) => new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const iconFor = (f: FItem) =>
  f.kind === "folder" ? "folder" : /^image\//.test(f.mime ?? "") ? "eye" : /pdf|word|text|document/.test(f.mime ?? "") ? "docs" : /sheet|excel|csv/.test(f.mime ?? "") ? "sheets" : /presentation|powerpoint/.test(f.mime ?? "") ? "slides" : /video|audio/.test(f.mime ?? "") ? "meet" : "files";
const previewable = (f: FItem) => /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav)|text\/plain)$/.test(f.mime ?? "");

/**
 * Files: the company's own file storage. My files (with folders), Shared
 * with me, Trash, search, upload (drag and drop), preview, share with
 * colleagues or as an expiring link, and, for admins, storage limits.
 */
export default function FilesApp({ admin, initialView = "mine" }: { admin: boolean; initialView?: string }) {
  useTabTitle("Files");
  const [view, setView] = useState(initialView);
  const [folder, setFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<FItem | null>(null);
  const [sharing, setSharing] = useState<FItem | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ view, ...(folder ? { folder } : {}), ...(search ? { search } : {}) });
    const r = await fetch(`/api/files?${q}`, { cache: "no-store" }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (!r?.ok || !d) return setError(d?.error ?? "Couldn't load your files.");
    setError(null);
    setList(d);
  }, [view, folder, search]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const post = async (body: Record<string, unknown>, ok?: string) => {
    const r = await fetch("/api/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) {
      setNote(d.error ?? "That didn't work.");
      return null;
    }
    if (ok) setNote(ok);
    await load();
    return d;
  };

  const upload = async (files: FileList | File[]) => {
    const all = [...files];
    if (!all.length) return;
    setBusy(true);
    const form = new FormData();
    for (const f of all) form.append("files", f);
    if (folder && view !== "trash") form.append("parentId", folder);
    const r = await fetch("/api/files/upload", { method: "POST", body: form }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    const ok = (d.items ?? []).length;
    const errs = (d.errors ?? []) as { name: string; error: string }[];
    setNote(errs.length ? `${ok ? `${ok} uploaded. ` : ""}${errs[0].name}: ${errs[0].error}` : `${ok} ${ok === 1 ? "file" : "files"} uploaded.`);
    await load();
  };

  const open = (f: FItem) => {
    if (f.trashedAt) return;
    if (f.kind === "folder") {
      setFolder(f.id);
      setTyped("");
      setSearch("");
    } else if (previewable(f)) setPreview(f);
    else window.open(`/api/files/${f.id}`, "_blank");
  };
  const go = (v: string) => {
    setView(v);
    setFolder(null);
    setTyped("");
    setSearch("");
  };
  const u = list?.usage;
  const canAdd = view !== "trash" && !search && (view === "mine" || (folder && list?.access !== "view"));

  return (
    <div className="ix-files">
      <aside className="ix-files-nav">
        <button type="button" className="ix-btn primary ix-files-up" disabled={!canAdd || busy} onClick={() => pick.current?.click()}>
          <Icon name="add" size={15} /> Upload
        </button>
        <input ref={pick} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files).then(() => (e.target.value = ""))} />
        {[
          ["mine", "folder", "My files"],
          ["shared", "people", "Shared with me"],
          ["trash", "trash", "Trash"],
          ...(admin ? [["storage", "settings", "Storage"]] : []),
        ].map(([v, icon, label]) => (
          <button key={v} type="button" className={`ix-files-tab ${view === v ? "on" : ""}`} onClick={() => go(v)}>
            <Icon name={icon} size={16} /> {label}
          </button>
        ))}
        {u && (
          <div className="ix-files-usage" title={`${bytes(u.used)} of ${bytes(u.limit)}`}>
            <span className="track">
              <i style={{ width: `${Math.min(100, (u.used / Math.max(1, u.limit)) * 100)}%` }} className={u.used / u.limit > 0.9 ? "full" : ""} />
            </span>
            <small>
              {bytes(u.used)} of {bytes(u.limit)} used
            </small>
          </div>
        )}
      </aside>

      <main
        className={`ix-files-main ${drag ? "drag" : ""}`}
        onDragOver={(e) => {
          if (!canAdd || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
        onDrop={(e) => {
          if (!canAdd) return;
          e.preventDefault();
          setDrag(false);
          void upload(e.dataTransfer.files);
        }}
      >
        {view === "storage" ? (
          <StorageAdmin onNote={setNote} />
        ) : (
          <>
            <div className="ix-files-bar">
              <nav className="ix-files-crumbs" aria-label="Folder">
                <button type="button" onClick={() => setFolder(null)}>
                  {view === "shared" ? "Shared with me" : view === "trash" ? "Trash" : "My files"}
                </button>
                {list?.crumbs.map((c) => (
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
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search your files" aria-label="Search files" />
              </div>
              {canAdd && (
                <button type="button" className="ix-btn" onClick={() => setNewFolder("")}>
                  <Icon name="folder" size={14} /> New folder
                </button>
              )}
              {view === "trash" && !!list?.items.length && (
                <button type="button" className="ix-btn danger" onClick={() => void post({ action: "emptyTrash" }, "Trash emptied.")}>
                  Empty Trash
                </button>
              )}
            </div>
            {error && <p className="ix-error">{error}</p>}
            {newFolder !== null && (
              <form
                className="ix-files-inline"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await post({ action: "folder", name: newFolder, parentId: folder }, "Folder created.")) setNewFolder(null);
                }}
              >
                <Icon name="folder" size={16} />
                <input autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="Folder name" maxLength={200} />
                <button type="submit" className="ix-btn primary">
                  Create
                </button>
                <button type="button" className="ix-btn" onClick={() => setNewFolder(null)}>
                  Cancel
                </button>
              </form>
            )}
            <div className="ix-usage-tablewrap">
              <table className="ix-usage-table ix-files-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>{view === "shared" ? "Owner" : "Shared"}</th>
                    <th>{view === "trash" ? "Deleted" : "Modified"}</th>
                    <th className="r">Size</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {list?.items.map((f) => (
                    <tr key={f.id} onDoubleClick={() => open(f)}>
                      <td>
                        {renaming?.id === f.id ? (
                          <form
                            className="ix-files-inline tight"
                            onSubmit={async (e) => {
                              e.preventDefault();
                              if (await post({ action: "rename", id: f.id, name: renaming.name })) setRenaming(null);
                            }}
                          >
                            <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: f.id, name: e.target.value })} onBlur={() => setRenaming(null)} maxLength={200} />
                          </form>
                        ) : (
                          <button type="button" className="ix-files-name" onClick={() => open(f)}>
                            <span className={`ix-files-ico k-${f.kind}`}>
                              <Icon name={iconFor(f)} size={15} />
                            </span>
                            {f.name}
                          </button>
                        )}
                      </td>
                      <td className="dim">{view === "shared" ? f.ownerName : f.shared ? `${f.shared} ${f.shared === 1 ? "share" : "shares"}` : "—"}</td>
                      <td className="nowrap dim">{when(f.trashedAt ?? f.updatedAt)}</td>
                      <td className="r mono dim">{f.kind === "file" ? bytes(f.size) : "—"}</td>
                      <td className="r nowrap">
                        <span className="ix-files-acts">
                          {view === "trash" ? (
                            <>
                              <button type="button" className="ix-btn" onClick={() => void post({ action: "restore", id: f.id }, `${f.name} restored.`)}>
                                Restore
                              </button>
                              <button type="button" className="ix-btn danger" onClick={() => void post({ action: "delete", id: f.id }, `${f.name} deleted for good.`)}>
                                Delete
                              </button>
                            </>
                          ) : (
                            <>
                              {f.kind === "file" && (
                                <a className="ix-act" href={`/api/files/${f.id}`} title="Download" aria-label={`Download ${f.name}`}>
                                  <Icon name="insert" size={14} />
                                </a>
                              )}
                              {f.access === "owner" && (
                                <button type="button" className="ix-act" title="Share" aria-label={`Share ${f.name}`} onClick={() => setSharing(f)}>
                                  <Icon name="people" size={14} />
                                </button>
                              )}
                              {f.access !== "view" && (
                                <>
                                  <button type="button" className="ix-act" title="Rename" aria-label={`Rename ${f.name}`} onClick={() => setRenaming({ id: f.id, name: f.name })}>
                                    <Icon name="edit" size={14} />
                                  </button>
                                  <button type="button" className="ix-act" title="Move to Trash" aria-label={`Move ${f.name} to Trash`} onClick={() => void post({ action: "trash", id: f.id }, `${f.name} moved to Trash.`)}>
                                    <Icon name="trash" size={14} />
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {list && !list.items.length && (
                    <tr>
                      <td colSpan={5} className="empty">
                        {search ? `Nothing matches "${search}".` : view === "trash" ? "Trash is empty." : view === "shared" && !folder ? "Nothing has been shared with you yet." : "Nothing here yet. Drop files here or press Upload."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {drag && <div className="ix-files-drop">Drop to upload here</div>}
          </>
        )}
      </main>

      {note && (
        <div className="ix-ppl-note" role="status">
          {note}
        </div>
      )}
      {preview && <Preview f={preview} onClose={() => setPreview(null)} />}
      {sharing && <ShareDialog f={sharing} onClose={() => (setSharing(null), void load())} onNote={setNote} />}
    </div>
  );
}

function Preview({ f, onClose }: { f: FItem; onClose: () => void }) {
  const src = `/api/files/${f.id}?inline=1`;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="ix-files-preview" role="dialog" aria-label={f.name} onClick={onClose}>
      <div className="ix-files-pv" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>{f.name}</b>
          <span className="dim">{bytes(f.size)}</span>
          <span style={{ flex: 1 }} />
          <a className="ix-btn" href={`/api/files/${f.id}`}>
            <Icon name="insert" size={14} /> Download
          </a>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="ix-files-pvbody">
          {/^image\//.test(f.mime ?? "") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={f.name} />
          ) : /^video\//.test(f.mime ?? "") ? (
            <video src={src} controls />
          ) : /^audio\//.test(f.mime ?? "") ? (
            <audio src={src} controls />
          ) : (
            <iframe src={src} title={f.name} sandbox="" />
          )}
        </div>
      </div>
    </div>
  );
}

function ShareDialog({ f, onClose, onNote }: { f: FItem; onClose: () => void; onNote: (s: string) => void }) {
  const [shares, setShares] = useState<{ id: string; kind: string; userId: string | null; name: string | null; canEdit: boolean; token: string | null; expiresAt: string | null }[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [who, setWho] = useState("");
  const [edit, setEdit] = useState(false);
  const [days, setDays] = useState(7);
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      fetch(`/api/files?shares=${f.id}`).then((r) => r.json()).catch(() => ({ shares: [] })),
      fetch("/api/workspace/members").then((r) => r.json()).catch(() => ({ members: [] })),
    ]);
    setShares(a.shares ?? []);
    setMembers(b.members ?? []);
  }, [f.id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) onNote(d.error ?? "That didn't work.");
    await load();
    return r?.ok ? d : null;
  };
  const people = shares.filter((s) => s.kind === "user");
  const links = shares.filter((s) => s.kind === "link");
  return (
    <div className="ix-ppl-drawer" role="dialog" aria-label={`Share ${f.name}`}>
      <form onSubmit={(e) => e.preventDefault()}>
        <header>
          <b>Share “{f.name}”</b>
          <button type="button" className="ix-act" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <label>
          With a colleague
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Choose someone</option>
            {members
              .filter((m) => !people.some((p) => p.userId === m.userId))
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name || m.email}
                </option>
              ))}
          </select>
        </label>
        <label className="ix-setup-check">
          <input type="checkbox" checked={edit} onChange={(e) => setEdit(e.target.checked)} />
          <span>
            <b>Can edit</b>
            <small>{f.kind === "folder" ? "Add, rename and delete inside the folder" : "Rename and replace"}</small>
          </span>
        </label>
        <button type="button" className="ix-btn primary" disabled={!who} onClick={async () => (await post({ action: "share", id: f.id, userId: who, canEdit: edit })) && (setWho(""), setEdit(false))}>
          Share
        </button>
        {people.length > 0 && (
          <ul className="ix-files-shares">
            {people.map((s) => (
              <li key={s.id}>
                <span>{s.name}</span>
                <small className="dim">{s.canEdit ? "Can edit" : "Can view"}</small>
                <button type="button" className="ix-act" aria-label={`Stop sharing with ${s.name}`} onClick={() => void post({ action: "unshare", shareId: s.id })}>
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {f.kind === "file" && (
          <>
            <h3 className="ix-rules-h">Link for anyone</h3>
            <div className="ix-rules-add">
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Link expires after">
                {[1, 7, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    Expires in {d} {d === 1 ? "day" : "days"}
                  </option>
                ))}
              </select>
              <button type="button" className="ix-btn" onClick={() => void post({ action: "link", id: f.id, days })}>
                Make link
              </button>
            </div>
            {links.map((l) => {
              const url = `${typeof window === "undefined" ? "" : window.location.origin}/api/files/link/${l.token}`;
              return (
                <div key={l.id} className="ix-files-link">
                  <code>{url}</code>
                  <small className="dim">Expires {l.expiresAt ? new Date(l.expiresAt).toLocaleDateString() : "never"}</small>
                  <button type="button" className="ix-act" title="Copy" aria-label="Copy link" onClick={() => void navigator.clipboard?.writeText(url).then(() => onNote("Link copied."))}>
                    <Icon name="copy" size={13} />
                  </button>
                  <button type="button" className="ix-act" title="Remove link" aria-label="Remove link" onClick={() => void post({ action: "unshare", shareId: l.id })}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              );
            })}
          </>
        )}
      </form>
    </div>
  );
}

type Admin = { company: number | null; perPerson: number; used: number; disk: { free: number; total: number } | null; people: { userId: string; name: string; email: string; used: number; files: number; limit: number; custom: boolean }[] };

/** Owners and admins: the company's total, the default per person, and per-person limits. */
function StorageAdmin({ onNote }: { onNote: (s: string) => void }) {
  const [a, setA] = useState<Admin | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const gb = (n: number) => String(Math.round((n / 1024 ** 3) * 10) / 10);
  const load = useCallback(async () => {
    const d = await fetch("/api/files?admin=1", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (d && !d.error) {
      setA(d);
      setEdit({ company: d.company === null ? "" : gb(d.company), default: gb(d.perPerson) });
    } else onNote(d?.error ?? "Couldn't load storage.");
  }, [onNote]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const save = async (who: string, value: string) => {
    const r = await fetch("/api/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "limit", who, gb: value.trim() === "" ? null : Number(value) }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    onNote(r?.ok ? "Saved." : (d.error ?? "Couldn't save."));
    await load();
  };
  if (!a) return <p className="dim">Loading storage…</p>;
  return (
    <div className="ix-files-admin">
      <div className="ix-usage-cards">
        <div className="ix-usage-card hero">
          <span>Company use</span>
          <b>{bytes(a.used)}</b>
          <small>{a.company === null ? "No company limit" : `of ${bytes(a.company)}`}</small>
        </div>
        <div className="ix-usage-card">
          <span>Default per person</span>
          <b>{bytes(a.perPerson)}</b>
          <small>unless set below</small>
        </div>
        <div className="ix-usage-card">
          <span>Server disk free</span>
          <b>{a.disk ? bytes(a.disk.free) : "—"}</b>
          <small>{a.disk ? `of ${bytes(a.disk.total)}` : "unknown"}</small>
        </div>
      </div>
      <section className="ix-card ix-files-limits">
        <label>
          Company limit (GB)
          <input type="number" min={0.1} step={0.1} value={edit.company ?? ""} placeholder="No limit" onChange={(e) => setEdit({ ...edit, company: e.target.value })} />
          <button type="button" className="ix-btn" onClick={() => void save("company", edit.company ?? "")}>
            Save
          </button>
        </label>
        <label>
          Default per person (GB)
          <input type="number" min={0.1} step={0.1} value={edit.default ?? ""} onChange={(e) => setEdit({ ...edit, default: e.target.value })} />
          <button type="button" className="ix-btn" onClick={() => void save("default", edit.default ?? "5")}>
            Save
          </button>
        </label>
      </section>
      <section className="ix-card">
        <div className="ix-usage-tablewrap">
          <table className="ix-usage-table">
            <thead>
              <tr>
                <th>Person</th>
                <th className="r">Files</th>
                <th className="r">Used</th>
                <th>Limit (GB)</th>
              </tr>
            </thead>
            <tbody>
              {a.people.map((p) => (
                <tr key={p.userId}>
                  <td>
                    <b>{p.name}</b>
                    <div className="dim small">{p.email}</div>
                  </td>
                  <td className="r mono">{p.files}</td>
                  <td className="r mono">
                    {bytes(p.used)}
                    <span className="ix-off-bar" style={{ display: "inline-block", marginLeft: 8, verticalAlign: "middle", width: 70 }}>
                      <em style={{ width: `${Math.min(100, (p.used / Math.max(1, p.limit)) * 100)}%`, background: p.used / p.limit > 0.9 ? "#dc2626" : "var(--accent)" }} />
                    </span>
                  </td>
                  <td>
                    <span className="ix-files-limit">
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        defaultValue={gb(p.limit)}
                        aria-label={`Limit for ${p.name}`}
                        onBlur={(e) => e.target.value !== gb(p.limit) && void save(p.userId, e.target.value)}
                      />
                      {p.custom ? (
                        <button type="button" className="ix-act" title="Back to the default" aria-label="Use the default" onClick={() => void save(p.userId, "")}>
                          <Icon name="retry" size={13} />
                        </button>
                      ) : (
                        <small className="dim">default</small>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
