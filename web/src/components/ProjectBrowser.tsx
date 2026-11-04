"use client";

import AccessReview from "./AccessReview";
import FolderAccess from "./FolderAccess";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ProjectThumb from "./ProjectThumb";
import TemplateListingCard from "./TemplateListingCard";
import type { Listing } from "@/lib/listing";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  Check,
  EyeOff,
  Folder,
  FolderPlus,
  LayoutGrid,
  Link2,
  List,
  Lock,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";

type Card = {
  id: string;
  name: string;
  emoji: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  url: string | null;
  folderId: string | null;
  isTemplate: boolean;
  listing?: Listing | null;
  starred: boolean;
  createdByMe: boolean;
  visits7d: number;
  deletedAt: string | null;
  viewedAt: string | null;
  kind?: string;
  openFindings?: number;
};
type FolderRow = { id: string; name: string; parentId: string | null; count: number; restricted?: boolean; hidden?: boolean };
type Tmpl = { slug: string; name: string; category: string; blurb: string; personas?: string[] };

const VIEWS = [
  ["all", "All"],
  ["recent", "Recently viewed"],
  ["mine", "Created by me"],
  ["starred", "Starred"],
  ["shared", "Shared with me"],
  ["published", "Published"],
  ["popular", "Most visits"],
  ["design_systems", "Design systems"],
  ["templates", "Templates"],
  ["hidden", "Hidden"],
  ["deleted", "Recently deleted"],
] as const;
type View = (typeof VIEWS)[number][0];

/** Which activity group a project falls in, by when it was last edited. */
function activityBucket(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 30) return "This month";
  return "Older";
}

const STYLE_CHOICES = [
  ["", "Default"],
  ["minimal", "Minimal"],
  ["bold", "Bold"],
  ["playful", "Playful"],
  ["elegant", "Elegant"],
] as const;

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

export default function ProjectBrowser({ templates, categories }: { templates: Tmpl[]; categories: string[] }) {
  const router = useRouter();
  const [view, setView] = useState<View>("all");
  const [layout, setLayout] = useState<"grid" | "table">("grid");
  const [folder, setFolder] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [accessFolder, setAccessFolder] = useState<string | null>(null);
  const [items, setItems] = useState<Card[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("All");
  const [persona, setPersona] = useState<string>("Anyone");
  // The folder a dragged project is over.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  // The gallery shows a page at a time.
  const [shown, setShown] = useState(9);
  const [style, setStyle] = useState("");
  const [workspaceTemplates, setWorkspaceTemplates] = useState<Card[]>([]);

  const fetchList = useCallback(() => {
    const params = new URLSearchParams({ view: view === "templates" ? "templates" : view });
    if (query.trim()) params.set("q", query.trim());
    if ((view === "all" || view === "mine") && !query.trim()) params.set("folder", folder ?? "root");
    return fetch(`/api/projects?${params}`)
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => d.projects as Card[])
      .catch(() => [] as Card[]);
  }, [view, folder, query]);

  const fetchFolders = useCallback(
    () =>
      fetch("/api/folders")
        .then((r) => (r.ok ? r.json() : { folders: [] }))
        .then((d) => d.folders as FolderRow[])
        .catch(() => [] as FolderRow[]),
    [],
  );

  useEffect(() => {
    let live = true;
    Promise.all([fetchList(), fetchFolders()]).then(([list, fs]) => {
      if (!live) return;
      if (view === "templates") setWorkspaceTemplates(list);
      else setItems(list);
      setFolders(fs);
      setSelected(new Set());
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [fetchList, fetchFolders, view]);

  const refresh = useCallback(async () => {
    const [list, fs] = await Promise.all([fetchList(), fetchFolders()]);
    if (view === "templates") setWorkspaceTemplates(list);
    else setItems(list);
    setFolders(fs);
    setSelected(new Set());
  }, [fetchList, fetchFolders, view]);

  // Members and other workspaces, for "Change owner" and "Move to workspace".
  const [people, setPeople] = useState<{
    members: { userId: string; name: string | null; email: string | null }[];
    workspaces: { id: string; name: string }[];
  }>({ members: [], workspaces: [] });
  const selecting = selected.size > 0;
  const peopleLoaded = people.members.length > 0;
  useEffect(() => {
    if (!selecting || peopleLoaded) return;
    let live = true;
    Promise.all([
      fetch("/api/workspace/members").then((r) => (r.ok ? r.json() : { members: [] })),
      fetch("/api/workspace").then((r) => (r.ok ? r.json() : { workspaces: [] })),
    ]).then(([m, w]) => {
      if (!live) return;
      const current = w.workspace?.id;
      setPeople({
        members: m.members ?? [],
        workspaces: (w.workspaces ?? []).filter(
          (x: { id: string; role: string }) => x.id !== current && (x.role === "OWNER" || x.role === "ADMIN"),
        ),
      });
    });
    return () => {
      live = false;
    };
  }, [selecting, peopleLoaded]);

  async function bulk(action: string, extra: Record<string, unknown> = {}) {
    if (selected.size === 0) return;
    if (action === "purge" && !confirm(`Permanently delete ${selected.size} project(s)? This can't be undone.`)) return;
    setBusy(action);
    await fetch("/api/projects/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ids: [...selected], ...extra }),
    });
    setBusy(null);
    await refresh();
  }

  /** Drop dragged projects into a folder (null = the top level). */
  async function dropInto(folderId: string | null, e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData("application/x-forge-project");
    if (!id) return;
    const ids = selected.has(id) ? [...selected] : [id];
    setBusy("move");
    await fetch("/api/projects/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "move", ids, folderId }),
    });
    setBusy(null);
    await refresh();
  }
  const dragProps = (id: string) =>
    view === "all" || view === "mine"
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData("application/x-forge-project", id);
            e.dataTransfer.effectAllowed = "move";
          },
        }
      : {};
  const dropProps = (folderId: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/x-forge-project")) return;
      e.preventDefault();
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: React.DragEvent) => void dropInto(folderId, e),
  });

  async function newFolder() {
    const name = prompt("Folder name");
    if (!name?.trim()) return;
    await fetch("/api/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parentId: folder }),
    });
    await refresh();
  }

  async function removeFolder(id: string) {
    if (!confirm("Delete this folder? Its projects move up a level.")) return;
    await fetch(`/api/folders?id=${id}`, { method: "DELETE" });
    if (folder === id) setFolder(folders.find((f) => f.id === id)?.parentId ?? null);
    await refresh();
  }

  /** Hiding a folder only changes your own lists. */
  async function hideFolder(id: string, hidden: boolean) {
    await fetch("/api/folders", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, hidden }) });
    await refresh();
  }

  async function startTemplate(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const { project, seed } = await res.json();
        if (seed) sessionStorage.setItem(`seed:${project.id}`, seed);
        router.push(`/projects/${project.id}`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function copyLink(p: Card) {
    const link = p.url ?? `${location.origin}/projects/${p.id}`;
    await navigator.clipboard.writeText(link).catch(() => undefined);
    setCopied(p.id);
    setTimeout(() => setCopied(null), 1500);
  }

  // Folder breadcrumb and children of the current folder.
  const trail = useMemo(() => {
    const out: FolderRow[] = [];
    let cursor = folder;
    while (cursor) {
      const f = folders.find((x) => x.id === cursor);
      if (!f) break;
      out.unshift(f);
      cursor = f.parentId;
    }
    return out;
  }, [folder, folders]);
  const allChildFolders = folders.filter((f) => f.parentId === folder);
  const hiddenChildCount = allChildFolders.filter((f) => f.hidden).length;
  const childFolders = showHiddenFolders ? allChildFolders : allChildFolders.filter((f) => !f.hidden);
  const hiddenFolders = folders.filter((f) => f.hidden);
  const showFolders = (view === "all" || view === "mine") && !query.trim();

  const filteredTemplates = templates.filter(
    (t) =>
      (category === "All" || t.category === category) &&
      (persona === "Anyone" || (t.personas ?? []).includes(persona)) &&
      (!query.trim() || `${t.name} ${t.blurb} ${t.category}`.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      {reviewing && <AccessReview ids={[...selected]} onClose={() => setReviewing(false)} />}
      {accessFolder && <FolderAccess folderId={accessFolder} onClose={() => setAccessFolder(null)} onChanged={() => void refresh()} />}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-0.5" role="tablist">
          {VIEWS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              onClick={() => {
                setView(id);
                setFolder(null);
              }}
              className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                view === id ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : "hover:bg-black/[.03] dark:hover:bg-white/[.05]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search projects"
            className="w-48 rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none placeholder:opacity-50"
          />
          {view !== "templates" && (
            <div className="flex rounded-lg border" role="group" aria-label="Layout">
              <button
                onClick={() => setLayout("grid")}
                aria-pressed={layout === "grid"}
                aria-label="Grid view"
                className={`p-1.5 ${layout === "grid" ? "bg-black/[.06] dark:bg-white/[.08]" : ""}`}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setLayout("table")}
                aria-pressed={layout === "table"}
                aria-label="Table view"
                className={`p-1.5 ${layout === "table" ? "bg-black/[.06] dark:bg-white/[.08]" : ""}`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {view === "templates" ? (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {["All", ...categories].map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={`rounded-full border px-2.5 py-1 text-[11px] ${category === c ? "border-[#6d4aff] bg-[#6d4aff]/10 font-medium" : ""}`}
              >
                {c}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
              For
              <select
                value={persona}
                onChange={(e) => {
                  setPersona(e.target.value);
                  setShown(9);
                }}
                aria-label="Who it's for"
                className="rounded-md border bg-transparent px-1.5 py-0.5 text-[11px]"
              >
                {["Anyone", ...new Set(templates.flatMap((t) => t.personas ?? []))].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="ml-auto flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
              Style
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                className="rounded-md border bg-transparent px-1.5 py-0.5 text-[11px]"
              >
                {STYLE_CHOICES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {workspaceTemplates.length > 0 && (
            <>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Workspace templates
              </h3>
              <ul className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {workspaceTemplates.map((p) => (
                  <TemplateListingCard
                    key={p.id}
                    card={p}
                    busy={busy === p.id}
                    onUse={() => startTemplate({ fromProject: p.id }, p.id)}
                    onChanged={() => void refresh()}
                  />
                ))}
              </ul>
            </>
          )}

          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredTemplates.slice(0, shown).map((t) => (
              <li key={t.slug} className="flex flex-col rounded-xl border p-4" style={{ background: "var(--panel)" }}>
                <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  {t.category}
                </p>
                <Link href={`/templates/${t.slug}`} className="mt-1 text-sm font-medium hover:underline">
                  {t.name}
                </Link>
                <p className="mt-1 flex-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  {t.blurb}
                </p>
                <div className="mt-3 flex gap-2">
                  <Link href={`/templates/${t.slug}`} className="rounded-lg border px-3 py-1.5 text-xs">
                    Details
                  </Link>
                  <button
                    onClick={() => startTemplate({ name: t.name, template: t.slug, style }, t.slug)}
                    disabled={busy !== null}
                    className="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    style={{ background: "var(--accent)" }}
                  >
                    {busy === t.slug ? "Creating…" : "Use template"}
                  </button>
                </div>
              </li>
            ))}
            {filteredTemplates.length === 0 && (
              <li className="text-sm" style={{ color: "var(--muted)" }}>
                No templates match.
              </li>
            )}
          </ul>
          {filteredTemplates.length > shown && (
            <button onClick={() => setShown((n) => n + 9)} className="mx-auto mt-4 block rounded-lg border px-4 py-1.5 text-xs">
              Load more ({filteredTemplates.length - shown} more)
            </button>
          )}
        </div>
      ) : (
        <div>
          {view === "hidden" && hiddenFolders.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span style={{ color: "var(--muted)" }}>Hidden folders:</span>
              {hiddenFolders.map((f) => (
                <span key={f.id} className="flex items-center gap-1.5 rounded-lg border px-2 py-1">
                  <Folder className="h-3.5 w-3.5" /> {f.name}
                  <button onClick={() => void hideFolder(f.id, false)} className="underline">
                    Unhide
                  </button>
                </span>
              ))}
            </div>
          )}
          {showFolders && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <nav aria-label="Folder" className="flex items-center gap-1 text-xs">
                <button
                  onClick={() => setFolder(null)}
                  {...dropProps(null, "root")}
                  className={`rounded px-1 hover:underline ${dropTarget === "root" ? "bg-[#6d4aff]/10 ring-1 ring-[#6d4aff]" : ""}`}
                  style={folder ? { color: "var(--muted)" } : undefined}
                >
                  All projects
                </button>
                {trail.map((f) => (
                  <span key={f.id} className="flex items-center gap-1">
                    <span style={{ color: "var(--muted)" }}>/</span>
                    <button onClick={() => setFolder(f.id)} className="hover:underline">
                      {f.name}
                    </button>
                  </span>
                ))}
              </nav>
              <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" />
              {childFolders.map((f) => (
                <span key={f.id} {...dropProps(f.id, f.id)} className={`group flex items-center rounded-lg border ${dropTarget === f.id ? "border-[#6d4aff] bg-[#6d4aff]/10" : ""}`}>
                  <button onClick={() => setFolder(f.id)} className="flex items-center gap-1.5 px-2 py-1 text-xs">
                    {f.restricted ? <Lock className="h-3.5 w-3.5" aria-label="Restricted" /> : <Folder className="h-3.5 w-3.5" />} {f.name}
                    <span style={{ color: "var(--muted)" }}>{f.count}</span>
                    {f.hidden && <EyeOff className="h-3 w-3" aria-label="Hidden" style={{ color: "var(--muted)" }} />}
                  </button>
                  <button onClick={() => setAccessFolder(f.id)} className="hidden px-1 text-[11px] group-focus-within:block group-hover:block" style={{ color: "var(--muted)" }} title="See who can see this folder">
                    Access
                  </button>
                  <button
                    onClick={() => void hideFolder(f.id, !f.hidden)}
                    className="hidden px-1 text-[11px] group-focus-within:block group-hover:block"
                    style={{ color: "var(--muted)" }}
                    title={f.hidden ? "Show this folder in your lists again" : "Hide from your lists (only for you)"}
                  >
                    {f.hidden ? "Unhide" : "Hide"}
                  </button>
                  <button
                    onClick={() => removeFolder(f.id)}
                    aria-label={`Delete folder ${f.name}`}
                    className="hidden px-1 group-focus-within:block group-hover:block"
                    style={{ color: "var(--muted)" }}
                  >
                    ×
                  </button>
                </span>
              ))}
              {hiddenChildCount > 0 && (
                <button onClick={() => setShowHiddenFolders((v) => !v)} className="rounded-lg px-2 py-1 text-xs hover:bg-black/[.04]" style={{ color: "var(--muted)" }}>
                  {showHiddenFolders ? "Hide hidden folders" : `${hiddenChildCount} hidden`}
                </button>
              )}
              <button onClick={newFolder} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-black/[.04]" style={{ color: "var(--muted)" }}>
                <FolderPlus className="h-3.5 w-3.5" /> New folder
              </button>
              {(["design_system", "canvas", "library"] as const).map((k) => (
                <button
                  key={k}
                  onClick={async () => {
                    const name = prompt(k === "canvas" ? "Name the canvas" : k === "library" ? "Name the library" : "Name the design system");
                    if (!name?.trim()) return;
                    const res = await fetch("/api/projects", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ name: name.trim(), kind: k }),
                    });
                    const d = await res.json().catch(() => null);
                    if (d?.seed) sessionStorage.setItem(`seed:${d.project.id}`, d.seed);
                    if (d?.project) router.push(`/projects/${d.project.id}`);
                  }}
                  className="rounded-lg px-2 py-1 text-xs hover:bg-black/[.04]"
                  style={{ color: "var(--muted)" }}
                >
                  {k === "canvas" ? "+ New canvas" : k === "library" ? "+ Create library project" : "+ New design system"}
                </button>
              ))}
            </div>
          )}

          {selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs" style={{ background: "var(--panel)" }} role="toolbar">
              <span className="font-medium">{selected.size} selected</span>
              <button onClick={() => setSelected(new Set())} className="hover:underline" style={{ color: "var(--muted)" }}>
                Clear
              </button>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                {view === "deleted" ? (
                  <>
                    <button disabled={!!busy} onClick={() => bulk("restore")} className="flex items-center gap-1 rounded-md border px-2 py-1">
                      <RotateCcw className="h-3.5 w-3.5" /> Restore
                    </button>
                    <button disabled={!!busy} onClick={() => bulk("purge")} className="rounded-md border border-red-300 px-2 py-1 text-red-600">
                      Delete permanently
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      disabled={!!busy}
                      onClick={() => bulk(view === "hidden" ? "unhide" : "hide")}
                      title={view === "hidden" ? "Show these in your lists again" : "Hide from your lists (only for you)"}
                      className="rounded-md border px-2 py-1"
                    >
                      {view === "hidden" ? "Unhide" : "Hide"}
                    </button>
                    <button onClick={() => setReviewing(true)} className="rounded-md border px-2 py-1" title="Who can see and open the selected projects">
                      Review access
                    </button>
                    <button disabled={!!busy} onClick={() => bulk("star")} className="rounded-md border px-2 py-1">
                      Star
                    </button>
                    <select
                      aria-label="Move to folder"
                      value=""
                      onChange={(e) => e.target.value && bulk("move", { folderId: e.target.value === "root" ? null : e.target.value })}
                      className="rounded-md border bg-transparent px-1.5 py-1"
                    >
                      <option value="">Move to…</option>
                      <option value="root">No folder</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Change owner"
                      value=""
                      onChange={(e) => e.target.value && bulk("transfer", { ownerId: e.target.value })}
                      className="rounded-md border bg-transparent px-1.5 py-1"
                    >
                      <option value="">Change owner…</option>
                      {people.members.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name ?? m.email}
                        </option>
                      ))}
                    </select>
                    {people.workspaces.length > 0 && (
                      <select
                        aria-label="Move to workspace"
                        value=""
                        onChange={(e) => {
                          if (!e.target.value) return;
                          const name = people.workspaces.find((w) => w.id === e.target.value)?.name;
                          if (confirm(`Move ${selected.size} project(s) to ${name}? Collaborators keep their access; folders are cleared.`)) {
                            void bulk("moveWorkspace", { workspaceId: e.target.value });
                          }
                        }}
                        className="rounded-md border bg-transparent px-1.5 py-1"
                      >
                        <option value="">Move to workspace…</option>
                        {people.workspaces.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <button disabled={!!busy} onClick={() => bulk("unpublish")} className="rounded-md border px-2 py-1">
                      Unpublish
                    </button>
                    <button disabled={!!busy} onClick={() => bulk("delete")} className="flex items-center gap-1 rounded-md border px-2 py-1 text-red-600">
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </>
                )}
              </span>
            </div>
          )}

          {view === "deleted" && items.length > 0 && (
            <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
              Deleted projects stay here until you delete them permanently. Restore one to bring it back exactly as it was.
            </p>
          )}

          {layout === "grid" ? (
            <ul className="grid gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((p) => (
                <li key={p.id} className="group relative" {...dragProps(p.id)}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.name}`}
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className={`absolute left-3.5 top-3.5 z-10 h-4 w-4 ${selected.size ? "" : "opacity-0 group-hover:opacity-100"}`}
                  />
                  <Link
                    href={view === "deleted" ? "#" : `/projects/${p.id}`}
                    onClick={(e) => {
                      if (view === "deleted" || selected.size) {
                        e.preventDefault();
                        toggle(p.id);
                      }
                    }}
                    className={`card-lift block rounded-xl p-1 ${
                      selected.has(p.id) ? "ring-2 ring-[#6d4aff]" : ""
                    }`}
                  >
                    <ProjectThumb id={p.id} name={p.name} emoji={p.emoji} kind={p.kind} live={!!p.publishedAt} />
                    <div className="px-1 pt-2.5">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{p.name}</span>
                        {p.starred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                      </p>
                      <p className="mt-0.5 flex items-center gap-x-2 text-[13px]" style={{ color: "var(--muted)" }}>
                        <span className="truncate">
                          {view === "deleted" && p.deletedAt
                            ? `Deleted ${ago(p.deletedAt)}`
                            : view === "recent" && p.viewedAt
                              ? `Viewed ${ago(p.viewedAt)}`
                              : `Edited ${ago(p.updatedAt)}`}
                        </span>
                        {(p.openFindings ?? 0) > 0 && (
                          <span className="shrink-0 font-medium text-red-600" title="Open findings need attention">
                            {p.openFindings} {p.openFindings === 1 ? "finding" : "findings"}
                          </span>
                        )}
                        {p.url && (
                          <span className="flex shrink-0 items-center gap-0.5" title="Visits to the published site in the last 7 days">
                            <BarChart3 className="h-3 w-3" /> {p.visits7d}
                          </span>
                        )}
                      </p>
                    </div>
                  </Link>
                  {p.url && view !== "deleted" && (
                    <Link
                      href={`/projects/${p.id}/analytics`}
                      aria-label={`View analytics for ${p.name}`}
                      title="View analytics for this project"
                      className="absolute right-10 top-3 z-10 rounded-md bg-white/85 p-1 opacity-0 shadow-sm hover:bg-white group-hover:opacity-100"
                    >
                      <BarChart3 className="h-3.5 w-3.5" />
                    </Link>
                  )}
                  {view !== "deleted" && (
                    <button
                      onClick={() => copyLink(p)}
                      aria-label={`Copy link to ${p.name}`}
                      title={p.url ? "Copy the live link" : "Copy the project link"}
                      className="absolute right-3 top-3 z-10 rounded-md bg-white/85 p-1 opacity-0 shadow-sm hover:bg-white group-hover:opacity-100"
                    >
                      {copied === p.id ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                <tr className="border-b">
                  <th className="w-8 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={items.length > 0 && selected.size === items.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
                    />
                  </th>
                  <th className="py-2 font-medium">Name</th>
                  <th className="py-2 font-medium">Created</th>
                  <th className="py-2 font-medium">Edited</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium">Visits (7d)</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {items.map((p, i) => [
                  view !== "deleted" && view !== "recent" && activityBucket(p.updatedAt) !== (i ? activityBucket(items[i - 1].updatedAt) : "") ? (
                    <tr key={`b-${p.id}`}>
                      <td colSpan={7} className="pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                        {activityBucket(p.updatedAt)}
                      </td>
                    </tr>
                  ) : null,
                  <tr key={p.id} className="border-b hover:bg-black/[.02] dark:hover:bg-white/[.03]" {...dragProps(p.id)}>
                    <td className="py-2">
                      <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    </td>
                    <td className="py-2">
                      {view === "deleted" ? (
                        <span>{p.name}</span>
                      ) : (
                        <Link href={`/projects/${p.id}`} className="hover:underline">
                          {p.emoji ? `${p.emoji} ` : ""}
                          {p.name}
                        </Link>
                      )}
                    </td>
                    <td className="py-2 text-xs" style={{ color: "var(--muted)" }}>
                      {new Date(p.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 text-xs" style={{ color: "var(--muted)" }}>
                      {ago(p.updatedAt)}
                    </td>
                    <td className="py-2 text-xs">{p.deletedAt ? "Deleted" : p.publishedAt ? "Live" : "Draft"}</td>
                    <td className="py-2 text-xs">{p.url ? p.visits7d : "—"}</td>
                    <td className="py-2">
                      {view !== "deleted" && (
                        <button onClick={() => copyLink(p)} aria-label={`Copy link to ${p.name}`} className="rounded p-1 hover:bg-black/[.05]">
                          {copied === p.id ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </td>
                  </tr>,
                ])}
              </tbody>
            </table>
          )}

          {loaded && items.length === 0 && (
            <div className="mt-2 rounded-xl border border-dashed px-6 py-12 text-center text-sm" style={{ color: "var(--muted)" }}>
              {query ? "Nothing matches that search." : view === "deleted" ? "Nothing in Recently deleted." : "Nothing here yet."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
