"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { usePerms } from "@/components/iotx/PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { Icon } from "@/components/iotx/icons";
import SheetGrid from "./SheetGrid";

type Kind = "docs" | "sheets" | "slides";
const PAGE = 10;
type File = { id: string; name: string; modifiedTime: string; webViewLink: string; owners?: { displayName?: string }[] };
type Status = { configured: boolean; connection: { email: string; canEdit?: boolean } | null };

const META: Record<Kind, { title: string; noun: string; color: string; icon: string; preview: (id: string) => string }> = {
  docs: { title: "Docs", noun: "documents", color: "linear-gradient(135deg,#3730a3,#a78bfa)", icon: "docs", preview: (id) => `https://docs.google.com/document/d/${id}/preview` },
  sheets: { title: "Sheets", noun: "spreadsheets", color: "linear-gradient(135deg,#0f766e,#2dd4bf)", icon: "sheets", preview: (id) => `https://docs.google.com/spreadsheets/d/${id}/preview` },
  slides: { title: "Slides", noun: "presentations", color: "linear-gradient(135deg,#ea580c,#f472b6)", icon: "slides", preview: (id) => `https://docs.google.com/presentation/d/${id}/preview` },
};

/** Google Docs, Sheets or Slides inside the suite: browse, preview, open, and (Sheets) use as live app data. */
export default function GoogleFiles({ kind }: { kind: Kind }) {
  const m = META[kind];
  const perms = usePerms();
  const brand = useBrand();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [files, setFiles] = useState<File[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<File | null>(null);
  const [tab, setTab] = useState<"preview" | "data">("preview");
  const [data, setData] = useState<{ tabs: string[]; range: string; values: string[][] } | null>(null);
  const [range, setRange] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(() => {
    if (params.get("google") === "connected") return { ok: true, text: "Google Drive connected." };
    const e = params.get("google_error");
    return e ? { ok: false, text: e } : null;
  });
  const canLive = kind === "sheets" && perms.can("sheets.google.live");
  const [newName, setNewName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);
  // Editing needs the switch for this app and a Google connection with write access.
  const canEditFiles = perms.can(`${kind}.google.edit`) && !!status?.connection?.canEdit;
  const [collapsed, setCollapsed] = useState(false);
  const [page, setPage] = useState(0);
  const [full, setFull] = useState(false);
  const portal = (node: React.ReactNode) => (full && typeof document !== "undefined" ? createPortal(node, document.body) : node);
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [full]);

  useEffect(() => {
    fetch("/api/google?view=status").then((r) => r.json()).then(setStatus).catch(() => setStatus({ configured: false, connection: null }));
  }, []);

  const load = useCallback(
    async (append = false) => {
      setBusy("list");
      const p = new URLSearchParams({ view: "files", kind, ...(q ? { q } : {}), ...(append && next ? { page: next } : {}) });
      const r = await fetch(`/api/google?${p}`);
      const d = await r.json().catch(() => ({}));
      setBusy(null);
      if (!r.ok) return setMsg({ ok: false, text: d.error ?? "Couldn't load your files." });
      setFiles((cur) => (append && cur ? [...cur, ...d.files] : d.files));
      setNext(d.nextPageToken ?? null);
    },
    [kind, q, next],
  );
  useEffect(() => {
    if (status?.connection) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.connection]);

  async function showData(f: File, r = "") {
    setBusy("data");
    const [tabsRes, valRes] = await Promise.all([
      fetch(`/api/google?view=tabs&id=${f.id}`).then((x) => x.json()),
      fetch(`/api/google?${new URLSearchParams({ view: "values", id: f.id, ...(r ? { range: r } : {}) })}`).then((x) => x.json()),
    ]);
    setBusy(null);
    if (valRes.error) return setMsg({ ok: false, text: valRes.error });
    setData({ tabs: tabsRes.tabs ?? [], range: valRes.range, values: valRes.values });
  }

  async function googlePost(body: Record<string, unknown>) {
    const r = await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Google didn't accept that.");
    return d;
  }

  async function createNew() {
    setBusy("create");
    setMsg(null);
    try {
      const { file } = (await googlePost({ action: "create", kind, name: newName || "Untitled" })) as { file: File };
      setFiles((cur) => [file, ...(cur ?? [])]);
      setPage(0);
      setNewName(null);
      setSel(file);
      setTab(kind === "sheets" ? "data" : "preview");
      setData(null);
      if (kind === "sheets") void showData(file);
      setMsg({ ok: true, text: `Created "${file.name}".${kind === "sheets" ? "" : " Use “Edit in Google” to write in it."}` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(null);
  }

  /** Rename, copy or move to Trash the open file. */
  async function fileAction(action: "rename" | "copy" | "trash", extra: Record<string, unknown> = {}) {
    if (!sel) return;
    setBusy(action);
    setMsg(null);
    try {
      const d = (await googlePost({ action, id: sel.id, ...extra })) as { file?: File };
      if (action === "rename" && d.file) {
        setSel(d.file);
        setFiles((cur) => cur?.map((f) => (f.id === d.file!.id ? d.file! : f)) ?? cur);
        setRenaming(null);
      }
      if (action === "copy" && d.file) {
        setFiles((cur) => [d.file!, ...(cur ?? [])]);
        setSel(d.file);
        setMsg({ ok: true, text: `Made "${d.file.name}".` });
      }
      if (action === "trash") {
        setFiles((cur) => cur?.filter((f) => f.id !== sel.id) ?? cur);
        setMsg({ ok: true, text: `Moved "${sel.name}" to Google Drive's Trash. You can restore it there for 30 days.` });
        setSel(null);
        setFull(false);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setConfirmTrash(false);
    setBusy(null);
  }

  async function linkTo(projectId: string | "new") {
    if (!sel) return;
    setBusy("link");
    setMsg(null);
    let pid = projectId;
    if (pid === "new") {
      const r = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${sel.name} dashboard`.slice(0, 60), force: true }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.project) {
        setBusy(null);
        return setMsg({ ok: false, text: d.error ?? "Couldn't create the app." });
      }
      pid = d.project.id;
    }
    const r = await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "link", projectId: pid, spreadsheetId: sel.id }) });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: d.error ?? "Couldn't link the sheet." });
    if (projectId === "new") {
      try {
        sessionStorage.setItem(
          `seed:${pid}`,
          `Build a live dashboard from the Google Sheet "${sel.name}" (id ${sel.id}). It's already linked: read it with readSheetRows() from src/lib/live-sheets.ts and refresh every 60 seconds so changes in the sheet show up. Show the key totals as cards, a chart of the main numbers over time or by category, and a searchable table of the rows.`,
        );
      } catch {}
      router.push(`/projects/${pid}`);
      return;
    }
    setProjects(null);
    setMsg({ ok: true, text: `Linked. The app can now read "${sel.name}" live; ask the Builder to use it.` });
  }

  const muted = { color: "var(--ix-muted)" };
  const btn = "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-50";

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <span className="grid h-10 w-10 place-items-center rounded-full text-white" style={{ background: m.color }}><Icon name={m.icon} size={19} /></span>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">{m.title}</h1>
        <p className="text-sm" style={muted}>
          {status?.connection ? <>Your Google {m.title} from {status.connection.email}</> : <>Your Google {m.noun}, inside {brand.name}</>}
        </p>
      </div>
      {status?.connection && (
        <div className="flex gap-3">
          <a className="text-xs underline" style={muted} href={`/api/google/connect?back=/${kind}`}>
            Use a different Google account
          </a>
          <button type="button" className="text-xs underline" style={muted} onClick={async () => { await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disconnect" }) }); setStatus({ ...status, connection: null }); setFiles(null); }}>
            Disconnect Google
          </button>
        </div>
      )}
    </div>
  );

  if (!status) return <div className="p-8 text-sm" style={muted}>Loading…</div>;

  if (!status.connection) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-12">
        {header}
        <div className="rounded-xl border p-6" style={{ background: "var(--ix-panel)" }}>
          <h2 className="text-base font-semibold">Connect Google Drive</h2>
          <p className="mt-1 text-sm" style={muted}>
            See your Google Docs, Sheets and Slides here, open them in Google, and use a Google Sheet as live data for a dashboard: change the sheet, and the dashboard follows. {brand.shortName} only reads your files; it never changes or deletes them.
          </p>
          {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-600" : "text-red-500"}`} role="status">{msg.text}</p>}
          {status.configured ? (
            <a href={`/api/google/connect?back=/${kind}`} className="mt-4 inline-flex rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }}>
              Connect Google Drive
            </a>
          ) : (
            <p className="mt-4 text-sm text-amber-600">Google isn&rsquo;t set up on this server yet. Ask your platform admin.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col" style={{ height: "calc(100vh - 70px)" }}>
      <div className="border-b p-5" style={{ borderColor: "var(--ix-line)" }}>
        {header}
        {perms.can(`${kind}.google.edit`) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!status.connection.canEdit ? (
              <p className="text-sm">
                <a href={`/api/google/connect?back=/${kind}`} className="font-semibold underline" style={{ color: "var(--accent)" }}>Reconnect Google to allow editing</a>
                <span style={muted}> · your connection was made with read-only access.</span>
              </p>
            ) : newName === null ? (
              <button type="button" className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} onClick={() => setNewName("")}>
                + New {m.title === "Docs" ? "document" : m.title === "Sheets" ? "spreadsheet" : "presentation"}
              </button>
            ) : (
              <form className="flex flex-wrap gap-1.5" onSubmit={(e) => { e.preventDefault(); void createNew(); }}>
                <input autoFocus aria-label="Name" placeholder="Name" className="w-64 max-w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNewName(null)} />
                <button className={btn} disabled={busy === "create"}>{busy === "create" ? "Creating…" : "Create"}</button>
                <button type="button" className={btn} onClick={() => setNewName(null)}>Cancel</button>
              </form>
            )}
          </div>
        )}
        {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-600" : "text-red-500"}`} role="status">{msg.text}</p>}
      </div>
      <div className="flex min-h-0 flex-1">
        <section className={`min-w-0 flex-col border-r md:w-[380px] md:flex-none ${sel ? "hidden" : "flex flex-1"} ${collapsed ? "" : "md:flex"}`} style={{ borderColor: "var(--ix-line)" }}>
          <form className="flex gap-2 border-b p-2.5" style={{ borderColor: "var(--ix-line)" }} onSubmit={(e) => { e.preventDefault(); setPage(0); void load(); }}>
            <input aria-label={`Search ${m.noun}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${m.noun}`} className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-1.5 text-sm" />
            <button className={btn} disabled={busy === "list"}>{busy === "list" ? "…" : "Search"}</button>
            {sel && (
              <button type="button" className={`${btn} hidden md:inline-flex`} onClick={() => setCollapsed(true)} title="Hide the list" aria-label="Hide the list">
                ‹
              </button>
            )}
          </form>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {files === null && <p className="p-4 text-sm" style={muted}>Loading your {m.noun}…</p>}
            {files?.length === 0 && <p className="p-4 text-sm" style={muted}>No {m.noun} found.</p>}
            {files?.slice(page * PAGE, page * PAGE + PAGE).map((f) => (
              <button key={f.id} type="button" onClick={() => { setSel(f); setTab("preview"); setData(null); setProjects(null); setMsg(null); }} className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-left" style={{ borderColor: "var(--ix-line)", background: sel?.id === f.id ? "var(--accent-soft)" : undefined }}>
                <span className="grid h-8 w-8 flex-none place-items-center rounded-full text-white" style={{ background: m.color }}><Icon name={m.icon} size={14} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{f.name}</span>
                  <span className="block truncate text-xs" style={muted}>{new Date(f.modifiedTime).toLocaleDateString()}{f.owners?.[0]?.displayName ? ` · ${f.owners[0].displayName}` : ""}</span>
                </span>
              </button>
            ))}
          </div>
          {!!files?.length && (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm" style={{ borderColor: "var(--ix-line)" }}>
              <button type="button" className={btn} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <span style={muted}>
                {page * PAGE + 1}–{Math.min(files.length, page * PAGE + PAGE)} of {files.length}{next ? "+" : ""}
              </span>
              <button
                type="button"
                className={btn}
                disabled={busy === "list" || ((page + 1) * PAGE >= files.length && !next)}
                onClick={async () => {
                  if ((page + 1) * PAGE >= files.length && next) await load(true);
                  setPage((p) => p + 1);
                }}
              >
                {busy === "list" ? "…" : "Next →"}
              </button>
            </div>
          )}
        </section>

        {/* Full screen renders at the top of the page: inside the shell's content layer the sidebar and top bar would paint over it. */}
        {portal(<section
          className={full ? "fixed inset-0 z-[1000] flex flex-col" : `min-w-0 flex-1 flex-col ${sel ? "flex" : "hidden md:flex"}`}
          style={full ? { background: "var(--ix-bg, var(--bg))", color: "var(--ix-ink)", paddingTop: "env(safe-area-inset-top, 0px)" } : undefined}
        >
          {!sel ? (
            <div className="grid flex-1 place-items-center p-8 text-sm" style={muted}>Choose a file to preview it.</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b p-3" style={{ borderColor: "var(--ix-line)" }}>
                <button type="button" className="text-xs underline md:hidden" onClick={() => { setSel(null); setFull(false); }}>← Back</button>
                {collapsed && !full && (
                  <button type="button" className={`${btn} hidden md:inline-flex`} onClick={() => setCollapsed(false)} title="Show the list">
                    › Files
                  </button>
                )}
                {renaming !== null ? (
                  <form className="flex min-w-0 flex-1 gap-1.5" onSubmit={(e) => { e.preventDefault(); void fileAction("rename", { name: renaming }); }}>
                    <input autoFocus aria-label="New name" className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1 text-sm" value={renaming} onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} />
                    <button className={btn} disabled={busy === "rename"}>{busy === "rename" ? "…" : "Save"}</button>
                  </form>
                ) : (
                  <b className="min-w-0 flex-1 truncate text-sm" onDoubleClick={() => canEditFiles && setRenaming(sel.name)} title={canEditFiles ? "Double-click to rename" : undefined}>{sel.name}</b>
                )}
                {canEditFiles && renaming === null && (
                  <>
                    <button type="button" className={btn} onClick={() => setRenaming(sel.name)}>Rename</button>
                    <button type="button" className={btn} disabled={busy === "copy"} onClick={() => fileAction("copy", { name: `Copy of ${sel.name}` })}>{busy === "copy" ? "Copying…" : "Make a copy"}</button>
                    <button
                      type="button"
                      className={btn}
                      style={confirmTrash ? { background: "#dc2626", color: "#fff", borderColor: "#dc2626" } : { color: "#dc2626" }}
                      disabled={busy === "trash"}
                      onClick={() => (confirmTrash ? fileAction("trash") : setConfirmTrash(true))}
                      onBlur={() => setConfirmTrash(false)}
                    >
                      {busy === "trash" ? "Deleting…" : confirmTrash ? "Move to Trash?" : "Delete"}
                    </button>
                  </>
                )}
                <button type="button" className={btn} onClick={() => setFull((f) => !f)} title={full ? "Exit full screen (Esc)" : "Full screen"}>
                  {full ? "Exit full screen" : "⤢ Full screen"}
                </button>
                {kind === "sheets" && (
                  <div className="flex rounded-lg border p-0.5 text-xs">
                    {(["preview", "data"] as const).map((t) => (
                      <button key={t} type="button" className="rounded-md px-2.5 py-1" style={tab === t ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined} onClick={() => { setTab(t); if (t === "data" && !data) void showData(sel); }}>
                        {t === "preview" ? "Preview" : "Data"}
                      </button>
                    ))}
                  </div>
                )}
                {canLive && (
                  <button type="button" className={btn} disabled={busy === "link"} onClick={async () => setProjects((await fetch("/api/google?view=projects").then((r) => r.json())).projects ?? [])}>
                    Use as live data
                  </button>
                )}
                <a href={sel.webViewLink} target="_blank" rel="noopener noreferrer" className={btn}>{canEditFiles ? "Edit in Google ↗" : "Open in Google ↗"}</a>
              </div>

              {projects && (
                <div className="border-b p-3 text-sm" style={{ borderColor: "var(--ix-line)", background: "var(--ix-panel)" }}>
                  <b>Use &ldquo;{sel.name}&rdquo; as live data</b>
                  <p className="mt-0.5 text-xs" style={muted}>The app reads the sheet every minute, so changes in the sheet show up on its screens. Only this sheet is shared with the app.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {perms.builder && (
                      <button type="button" className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} disabled={busy === "link"} onClick={() => linkTo("new")}>
                        {busy === "link" ? "Setting up…" : "Build a new dashboard from it"}
                      </button>
                    )}
                    {projects.length > 0 && (
                      <select aria-label="Link to an existing app" className="rounded-lg border bg-transparent px-2 py-1.5 text-sm" defaultValue="" onChange={(e) => e.target.value && linkTo(e.target.value)}>
                        <option value="">Link to an existing app…</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    )}
                    <button type="button" className={btn} onClick={() => setProjects(null)}>Cancel</button>
                  </div>
                </div>
              )}

              {tab === "preview" || kind !== "sheets" ? (
                <iframe title={sel.name} src={m.preview(sel.id)} className="min-h-0 w-full flex-1 bg-white" />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <form className="flex flex-wrap items-center gap-2 border-b p-2.5" style={{ borderColor: "var(--ix-line)" }} onSubmit={(e) => { e.preventDefault(); void showData(sel, range); }}>
                    {data?.tabs?.length ? (
                      <select aria-label="Tab" className="rounded-lg border bg-transparent px-2 py-1 text-sm" onChange={(e) => { setRange(e.target.value); void showData(sel, e.target.value); }}>
                        {data.tabs.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    ) : null}
                    <input aria-label="Range" value={range} onChange={(e) => setRange(e.target.value)} placeholder="Range, e.g. Sheet1!A1:F100" className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1 text-sm" />
                    <button className={btn}>{busy === "data" ? "…" : "Refresh"}</button>
                  </form>
                  {!data ? (
                    <p className="p-4 text-sm" style={muted}>Loading values…</p>
                  ) : (
                    <SheetGrid
                      fileId={sel.id}
                      data={data}
                      editable={canEditFiles}
                      onReload={(r) => showData(sel, r ?? range)}
                      onError={(text) => setMsg({ ok: false, text })}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </section>)}
      </div>
    </div>
  );
}
