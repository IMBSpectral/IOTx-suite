"use client";

import "./sheets.css";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDownAZ, Copy, EllipsisVertical, ExternalLink, LayoutGrid, List, LoaderCircle, Pencil, Plus, Search, Sheet, Star, Trash } from "lucide-react";
import { usePerms } from "@/components/iotx/PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { Dropdown, MenuList, useDismiss } from "./Menu";

type File = { id: string; name: string; modifiedTime: string; viewedByMeTime?: string; starred?: boolean; ownedByMe?: boolean; webViewLink: string; thumbnailLink?: string; owners?: { displayName?: string }[] };
type Status = { configured: boolean; connection: { email: string; canEdit?: boolean } | null };
type Order = "opened" | "modifiedByMe" | "modified" | "name";
const ORDER_LABEL: Record<Order, string> = { opened: "Last opened by me", modifiedByMe: "Last modified by me", modified: "Last modified", name: "Title" };
// The Google connect flow is an API route (a full page load), not a page.
const CONNECT = "/api/google/connect?back=/sheets";
const OWNER_LABEL = { "": "Owned by anyone", me: "Owned by me", notme: "Not owned by me" } as const;

/** Google's way of showing a date in file lists: the time today, the day this year, otherwise the full date. */
function when(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** A small picture of a spreadsheet, for the Blank tile and file cards. */
function GridArt({ blank }: { blank?: boolean }) {
  return (
    <svg viewBox="0 0 150 112" width="100%" height="100%" aria-hidden>
      <rect width="150" height="112" fill="#fff" />
      {Array.from({ length: 9 }, (_, i) => (
        <line key={`h${i}`} x1="0" x2="150" y1={12 * i + 4} y2={12 * i + 4} stroke="#e2e3e3" />
      ))}
      {Array.from({ length: 6 }, (_, i) => (
        <line key={`v${i}`} y1="0" y2="112" x1={25 * i + 12} x2={25 * i + 12} stroke="#e2e3e3" />
      ))}
      {blank ? (
        <g transform="translate(75 58)">
          <circle r="20" fill="#fff" />
          <path d="M-11 0h22M0 -11v22" stroke="#0d9488" strokeWidth="4" strokeLinecap="round" />
        </g>
      ) : (
        <>
          <rect x="12" y="4" width="138" height="12" fill="#d9ead3" />
          {[28, 40, 52, 64].map((y) => (
            <rect key={y} x="40" y={y - 7} width={20 + ((y * 7) % 30)} height="4" rx="2" fill="#c4c7c5" />
          ))}
        </>
      )}
    </svg>
  );
}

/**
 * Sheets home, like Google Sheets: start a new spreadsheet, then the
 * person's recent spreadsheets as a list or a grid, with search, sort and an
 * owner filter. Opening one goes to the full-width editor.
 */
export default function SheetsHome() {
  const perms = usePerms();
  const brand = useBrand();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [files, setFiles] = useState<File[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<Order>("opened");
  const [owner, setOwner] = useState<"" | "me" | "notme">("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmTrash, setConfirmTrash] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(() => {
    if (params.get("google") === "connected") return { ok: true, text: "Google Drive connected." };
    if (params.get("trashed")) return { ok: true, text: "Moved to Google Drive's Trash. You can restore it there for 30 days." };
    const e = params.get("google_error");
    return e ? { ok: false, text: e } : null;
  });
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canEdit = perms.can("sheets.google.edit") && !!status?.connection?.canEdit;

  useEffect(() => {
    fetch("/api/google?view=status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connection: null }));
  }, []);

  const connected = !!status?.connection;
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const p = new URLSearchParams({ view: "files", kind: "sheets", order, ...(query ? { q: query } : {}), ...(owner ? { owner } : {}) });
    fetch(`/api/google?${p}`)
      .then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
      .then(({ ok, d }) => {
        if (!live) return;
        if (!ok) return setMsg({ ok: false, text: d.error ?? "Couldn't load your spreadsheets." });
        setFiles(d.files ?? []);
        setNext(d.nextPageToken ?? null);
      });
    return () => {
      live = false;
    };
  }, [connected, order, query, owner]);

  async function more() {
    if (!next) return;
    setBusy("more");
    const p = new URLSearchParams({ view: "files", kind: "sheets", order, page: next, ...(query ? { q: query } : {}), ...(owner ? { owner } : {}) });
    const d = await fetch(`/api/google?${p}`).then((r) => r.json()).catch(() => ({}));
    setBusy(null);
    setFiles((cur) => [...(cur ?? []), ...(d.files ?? [])]);
    setNext(d.nextPageToken ?? null);
  }

  async function googlePost(body: Record<string, unknown>) {
    const r = await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Google didn't accept that.");
    return d;
  }
  async function create() {
    setBusy("create");
    try {
      const { file } = await googlePost({ action: "create", kind: "sheets", name: "Untitled spreadsheet" });
      router.push(`/sheets/${file.id}`);
    } catch (e) {
      setBusy(null);
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  async function act(action: "rename" | "copy" | "trash", f: File, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setMsg(null);
    try {
      const d = await googlePost({ action, id: f.id, ...extra });
      if (action === "rename") setFiles((cur) => cur?.map((x) => (x.id === f.id ? { ...x, name: d.file.name } : x)) ?? cur);
      if (action === "copy") {
        setFiles((cur) => [d.file, ...(cur ?? [])]);
        setMsg({ ok: true, text: `Made "${d.file.name}".` });
      }
      if (action === "trash") {
        setFiles((cur) => cur?.filter((x) => x.id !== f.id) ?? cur);
        setMsg({ ok: true, text: `Moved "${f.name}" to Google Drive's Trash. You can restore it there for 30 days.` });
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(null);
  }

  const muted = { color: "var(--ix-muted)" };
  if (!status) return <div className="p-8 text-sm" style={muted}>Loading…</div>;

  const head = (
    <div className="flex flex-wrap items-center gap-3">
      <span className="grid h-10 w-10 flex-none place-items-center rounded-lg text-white" style={{ background: "linear-gradient(135deg,#0f766e,#2dd4bf)" }}>
        <Sheet size={21} />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">Sheets</h1>
        <p className="truncate text-sm" style={muted}>
          {status.connection ? <>Google Sheets from {status.connection.email}</> : <>Your Google spreadsheets, inside {brand.name}</>}
        </p>
      </div>
      {status.connection && (
        <div className="flex gap-3 text-xs">
          <a className="underline" style={muted} href={CONNECT}>
            Use a different Google account
          </a>
          <button
            type="button"
            className="underline"
            style={muted}
            onClick={async () => {
              await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disconnect" }) });
              setStatus({ ...status, connection: null });
              setFiles(null);
            }}
          >
            Disconnect Google
          </button>
        </div>
      )}
    </div>
  );
  const note = msg && (
    <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-600" : "text-red-500"}`} role="status">
      {msg.text}
    </p>
  );

  if (!status.connection) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-12">
        {head}
        <div className="rounded-xl border p-6" style={{ background: "var(--ix-panel)", borderColor: "var(--ix-line)" }}>
          <h2 className="text-base font-semibold">Connect Google Drive</h2>
          <p className="mt-1 text-sm" style={muted}>
            Open and edit the spreadsheets in your Google Drive here: formulas, formatting, tabs and sharing. Changes are saved straight to the same file in your Drive. You can also use a sheet as live data for a dashboard.
          </p>
          {note}
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

  const menuFor = (f: File) => [
    { label: "Open in a new tab", icon: <ExternalLink size={15} />, onClick: () => window.open(`/sheets/${f.id}`, "_blank") },
    { label: "Open in Google Sheets", icon: <ExternalLink size={15} />, onClick: () => window.open(f.webViewLink, "_blank", "noopener,noreferrer") },
    ...(canEdit
      ? [
          "-" as const,
          { label: "Rename", icon: <Pencil size={15} />, onClick: () => setRenaming({ id: f.id, name: f.name }) },
          { label: "Make a copy", icon: <Copy size={15} />, onClick: () => void act("copy", f, { name: `Copy of ${f.name}` }) },
          { label: "Move to trash", icon: <Trash size={15} />, danger: true, onClick: () => setConfirmTrash(f) },
        ]
      : []),
  ];
  const ownerName = (f: File) => (f.ownedByMe ? "me" : f.owners?.[0]?.displayName ?? "");
  const dateOf = (f: File) => (order === "opened" ? when(f.viewedByMeTime) || when(f.modifiedTime) : when(f.modifiedTime));

  return (
    <div className="ox-home pb-10" style={{ ["--ox" as string]: "#0d9488" }}>
      <div className="px-5 pt-5 md:px-8">
        {head}
        {perms.can("sheets.google.edit") && !status.connection.canEdit && (
          <p className="mt-3 text-sm">
            <a href={CONNECT} className="font-semibold underline" style={{ color: "var(--accent)" }}>
              Reconnect Google to allow editing
            </a>
            <span style={muted}> · your connection was made with read-only access.</span>
          </p>
        )}
        {note}
        <form className="mt-4 flex max-w-2xl items-center gap-2 rounded-full border px-4 py-2" style={{ background: "var(--ix-panel)", borderColor: "var(--ix-line)" }} onSubmit={(e) => (e.preventDefault(), setQuery(q.trim()))}>
          <Search size={17} style={muted} />
          <input
            aria-label="Search spreadsheets"
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            value={q}
            onChange={(e) => {
              const v = e.target.value;
              setQ(v);
              clearTimeout(typing.current);
              typing.current = setTimeout(() => setQuery(v.trim()), 350);
            }}
          />
        </form>
      </div>

      {canEdit && (
        <section className="sh-start mt-5 px-5 py-5 md:px-8" aria-label="Start a new spreadsheet">
          <h2 className="mb-3 text-[15px] font-medium">Start a new spreadsheet</h2>
          <button type="button" className="sh-tile" onClick={create} disabled={busy === "create"} aria-label="Blank spreadsheet">
            <span className="thumb">{busy === "create" ? <LoaderCircle className="animate-spin" size={22} color="#0d9488" /> : <GridArt blank />}</span>
            <span className="text-sm font-medium">Blank spreadsheet</span>
          </button>
        </section>
      )}

      <section className="px-3 pt-5 md:px-6" aria-label="Recent spreadsheets">
        <div className="mb-2 flex flex-wrap items-center gap-2 px-2">
          <h2 className="flex-1 text-[15px] font-medium">{query ? `Results for “${query}”` : "Recent spreadsheets"}</h2>
          <Dropdown title="Owner" className="sx-btn" button={OWNER_LABEL[owner]} items={(["", "me", "notme"] as const).map((o) => ({ label: OWNER_LABEL[o], checked: owner === o, onClick: () => setOwner(o) }))} align="right" />
          <button type="button" className="sx-ibtn" title={view === "list" ? "Grid view" : "List view"} aria-label={view === "list" ? "Grid view" : "List view"} onClick={() => setView(view === "list" ? "grid" : "list")}>
            {view === "list" ? <LayoutGrid size={18} /> : <List size={18} />}
          </button>
          <Dropdown title="Sort options" className="sx-ibtn" button={<ArrowDownAZ size={18} />} align="right" items={(Object.keys(ORDER_LABEL) as Order[]).map((o) => ({ label: ORDER_LABEL[o], checked: order === o, onClick: () => setOrder(o) }))} />
        </div>
        {files === null && <p className="px-3 py-6 text-sm" style={muted}>Loading your spreadsheets…</p>}
        {files?.length === 0 && <p className="px-3 py-6 text-sm" style={muted}>{query ? "No spreadsheets match that search." : "No spreadsheets yet. Start a blank one above."}</p>}
        {!!files?.length && view === "list" && (
          <div role="list">
            <div className="sh-row" style={{ cursor: "default", fontSize: 12.5, fontWeight: 500 }}>
              <span className="pl-10">Name</span>
              <span className="sh-col">Owner</span>
              <span className="sh-col">{ORDER_LABEL[order === "name" ? "modified" : order]}</span>
              <span />
            </div>
            {files.map((f) => (
              <div key={f.id} role="listitem" className="sh-row" onClick={() => router.push(`/sheets/${f.id}`)}>
                <span className="flex min-w-0 items-center gap-3">
                  <Sheet size={20} color="#0d9488" className="flex-none" />
                  {renaming?.id === f.id ? (
                    <input
                      autoFocus
                      aria-label="New name"
                      className="sx-input min-w-0 flex-1"
                      value={renaming.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          setRenaming(null);
                          void act("rename", f, { name: renaming.name });
                        }
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => setRenaming(null)}
                    />
                  ) : (
                    <span className="truncate text-sm font-medium">{f.name}</span>
                  )}
                  {f.starred && <Star size={14} fill="#f59e0b" color="#f59e0b" className="flex-none" />}
                </span>
                <span className="sh-col truncate text-sm" style={muted}>
                  {ownerName(f)}
                </span>
                <span className="sh-col text-sm" style={muted}>
                  {dateOf(f)}
                </span>
                <RowMenu name={f.name} items={menuFor(f)} />
              </div>
            ))}
          </div>
        )}
        {!!files?.length && view === "grid" && (
          <div className="grid gap-4 px-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            {files.map((f) => (
              <div key={f.id} className="sh-card" role="button" tabIndex={0} aria-label={f.name} onClick={() => router.push(`/sheets/${f.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/sheets/${f.id}`)}>
                <div className="thumb">
                  <GridArt />
                </div>
                <div className="flex items-center gap-2 p-3">
                  <Sheet size={18} color="#0d9488" className="flex-none" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.name}</span>
                    <span className="block truncate text-xs" style={muted}>
                      {dateOf(f)}
                      {ownerName(f) && ownerName(f) !== "me" ? ` · ${ownerName(f)}` : ""}
                    </span>
                  </span>
                  <RowMenu name={f.name} items={menuFor(f)} />
                </div>
              </div>
            ))}
          </div>
        )}
        {next && (
          <div className="mt-4 flex justify-center">
            <button type="button" className="sx-btn" onClick={more} disabled={busy === "more"}>
              {busy === "more" ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </section>

      {confirmTrash && (
        <div className="sx-pop sx-dialog" role="dialog" aria-label="Move to trash?">
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Move to trash?</h2>
          <p className="mt-2 text-sm" style={muted}>
            &ldquo;{confirmTrash.name}&rdquo; goes to Google Drive&rsquo;s Trash. You can restore it there for 30 days.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="sx-btn" onClick={() => setConfirmTrash(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="sx-btn primary"
              style={{ background: "#dc2626", borderColor: "#dc2626" }}
              onClick={() => {
                const f = confirmTrash;
                setConfirmTrash(null);
                void act("trash", f);
              }}
            >
              Move to trash
            </button>
          </div>
        </div>
      )}
      {canEdit && (
        <button type="button" className="fixed bottom-6 right-6 grid h-14 w-14 place-items-center rounded-2xl shadow-lg md:hidden" style={{ background: "linear-gradient(135deg,#0f766e,#2dd4bf)", color: "#fff" }} aria-label="New spreadsheet" onClick={create}>
          <Plus size={24} />
        </button>
      )}
    </div>
  );
}

function RowMenu({ name, items }: { name: string; items: Parameters<typeof MenuList>[0]["items"] }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="sx-ibtn" aria-label={`More actions for ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <EllipsisVertical size={17} />
      </button>
      {open && <MenuList items={items} onDone={() => setOpen(false)} label={`Actions for ${name}`} style={{ position: "absolute", right: 0, top: "100%" }} />}
    </div>
  );
}
