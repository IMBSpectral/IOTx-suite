"use client";

import { useEffect, useMemo, useState } from "react";
import { useEscape } from "./useEscape";
import { Download, FileText, Film, FilePlus2, Image as ImageIcon, X } from "lucide-react";
import type { Collection, LibraryItem } from "@/lib/library";

const FILTERS = [
  ["all", "All"],
  ["image", "Images"],
  ["video", "Video"],
  ["document", "Documents"],
] as const;

function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Media and documents in the project and its chat uploads, with collections and preview. */
export default function LibraryPanel({
  projectId,
  onOpenFile,
}: {
  projectId: string;
  onOpenFile: (path: string) => void;
}) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [sort, setSort] = useState<"date" | "size" | "name">("date");
  const [q, setQ] = useState("");
  const [collection, setCollection] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<LibraryItem | null>(null);
  useEscape(preview ? () => setPreview(null) : null);
  const [fit, setFit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${projectId}/library`;
  const fileUrl = (key: string, download = false) => `${base}?key=${encodeURIComponent(key)}${download ? "&download=1" : ""}`;
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : { items: [], collections: [] }))
      .then((d) => {
        if (!live) return;
        setItems(d.items);
        setCollections(d.collections);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, version]);

  async function collectionAction(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setError(d.error ?? "Something went wrong"), null;
    setCollections(d.collections);
    return d.collections as Collection[];
  }

  async function newMarkdown() {
    const name = prompt("Name for the new Markdown file", "notes")?.trim();
    if (!name) return;
    const slug = name.replace(/\.md$/i, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "notes";
    const p = `docs/${slug}.md`;
    if (items.some((i) => i.path === p)) return setError(`${p} already exists.`);
    const res = await fetch(`/api/projects/${projectId}/files`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: p, content: `# ${name.replace(/\.md$/i, "")}\n\n` }),
    });
    if (!res.ok) return setError((await res.json().catch(() => ({}))).error ?? "Couldn't create the file.");
    setVersion((v) => v + 1);
    onOpenFile(p);
  }

  const active = collections.find((c) => c.id === collection) ?? null;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => filter === "all" || i.kind === filter)
      .filter((i) => !active || active.items.includes(i.key))
      .filter((i) => !needle || i.name.toLowerCase().includes(needle) || i.path?.toLowerCase().includes(needle))
      .sort((a, b) =>
        sort === "size" ? b.size - a.size : sort === "name" ? a.name.localeCompare(b.name) : b.modifiedAt.localeCompare(a.modifiedAt),
      );
  }, [items, filter, active, q, sort]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <div className="flex gap-0.5" role="radiogroup" aria-label="File type">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={filter === id}
              onClick={() => setFilter(id)}
              className={`rounded-md px-2 py-1 ${filter === id ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort by" className="rounded-md border bg-transparent px-1.5 py-1">
          <option value="date">Newest</option>
          <option value="size">Largest</option>
          <option value="name">Name</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files"
          aria-label="Search files"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 outline-none"
        />
        <button onClick={newMarkdown} className="flex items-center gap-1 rounded-md border px-2 py-1" title="Create an empty Markdown file to write in">
          <FilePlus2 className="h-3.5 w-3.5" /> Markdown file
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5 text-xs" aria-label="Collections">
        <button
          onClick={() => setCollection(null)}
          className={`rounded-full border px-2.5 py-0.5 ${collection === null ? "border-[#6d4aff] bg-[#6d4aff]/10" : ""}`}
        >
          All files
        </button>
        {collections.map((c) => (
          <button
            key={c.id}
            onClick={() => setCollection(c.id)}
            className={`rounded-full border px-2.5 py-0.5 ${collection === c.id ? "border-[#6d4aff] bg-[#6d4aff]/10" : ""}`}
          >
            {c.name} <span style={muted}>{c.items.length}</span>
          </button>
        ))}
        <button
          onClick={async () => {
            const name = prompt("Collection name")?.trim();
            if (name) await collectionAction({ action: "create", name });
          }}
          className="rounded-full border border-dashed px-2.5 py-0.5"
          style={muted}
        >
          + New collection
        </button>
        {active && (
          <span className="ml-auto flex gap-2">
            <button
              onClick={async () => {
                const name = prompt("Rename collection", active.name)?.trim();
                if (name) await collectionAction({ action: "rename", id: active.id, name });
              }}
              className="hover:underline"
              style={muted}
            >
              Rename
            </button>
            <button
              onClick={async () => {
                if (confirm(`Delete the collection "${active.name}"? The files stay.`)) {
                  await collectionAction({ action: "delete", id: active.id });
                  setCollection(null);
                }
              }}
              className="text-red-500 hover:underline"
            >
              Delete
            </button>
          </span>
        )}
      </div>

      {picked.size > 0 && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs" role="toolbar">
          <span className="font-medium">{picked.size} selected</span>
          {collections.length > 0 && (
            <select
              value=""
              aria-label="Add to collection"
              onChange={async (e) => {
                if (!e.target.value) return;
                if (await collectionAction({ action: "add", id: e.target.value, keys: [...picked] })) setPicked(new Set());
              }}
              className="rounded-md border bg-transparent px-1.5 py-1"
            >
              <option value="">Add to collection…</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {active && (
            <button
              onClick={async () => {
                if (await collectionAction({ action: "remove", id: active.id, keys: [...picked] })) setPicked(new Set());
              }}
              className="rounded-md border px-2 py-1"
            >
              Remove from {active.name}
            </button>
          )}
          <button onClick={() => setPicked(new Set())} style={muted}>
            Clear
          </button>
        </div>
      )}

      {error && (
        <p className="px-3 pt-2 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      <ul className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 overflow-y-auto p-3">
        {shown.length === 0 && (
          <li className="col-span-full py-10 text-center text-sm" style={muted}>
            {items.length ? "No files match." : "No images, videos or documents yet. Attach files in chat, or ask the agent to generate images."}
          </li>
        )}
        {shown.map((i) => (
          <li key={i.key} className="group relative overflow-hidden rounded-xl border" style={{ background: "var(--panel)" }}>
            <input
              type="checkbox"
              aria-label={`Select ${i.name}`}
              checked={picked.has(i.key)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(i.key);
                else next.delete(i.key);
                setPicked(next);
              }}
              className="absolute left-2 top-2 z-10"
            />
            <button onClick={() => (i.kind === "document" && i.path?.endsWith(".md") ? onOpenFile(i.path) : setPreview(i))} className="block w-full text-left">
              <div className="grid h-24 place-items-center overflow-hidden bg-black/[.03]">
                {i.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileUrl(i.key)} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : i.kind === "video" ? (
                  <Film className="h-6 w-6" style={muted} />
                ) : i.kind === "document" ? (
                  <FileText className="h-6 w-6" style={muted} />
                ) : (
                  <ImageIcon className="h-6 w-6" style={muted} />
                )}
              </div>
              <div className="px-2 py-1.5">
                <p className="truncate text-xs font-medium">{i.name}</p>
                <p className="truncate text-[10px]" style={muted}>
                  {size(i.size)} · {i.source === "upload" ? "Chat upload" : i.path}
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {preview && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-4" onClick={() => setPreview(null)} role="dialog" aria-label={`Preview ${preview.name}`}>
          <div className="flex items-center justify-between text-sm text-white" onClick={(e) => e.stopPropagation()}>
            <span className="truncate">{preview.name}</span>
            <span className="flex items-center gap-2">
              {preview.kind === "image" && (
                <button onClick={() => setFit((f) => !f)} className="rounded-md border border-white/30 px-2 py-1 text-xs">
                  {fit ? "Actual size" : "Fit to screen"}
                </button>
              )}
              <a href={fileUrl(preview.key, true)} className="flex items-center gap-1 rounded-md border border-white/30 px-2 py-1 text-xs">
                <Download className="h-3.5 w-3.5" /> Download
              </a>
              <button onClick={() => setPreview(null)} aria-label="Close preview" className="rounded-md p-1">
                <X className="h-4 w-4" />
              </button>
            </span>
          </div>
          <div className="mt-3 grid min-h-0 flex-1 place-items-center overflow-auto" onClick={(e) => e.stopPropagation()}>
            {preview.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(preview.key)} alt={preview.name} className={fit ? "max-h-full max-w-full object-contain" : "max-w-none"} />
            ) : preview.kind === "video" ? (
              <video src={fileUrl(preview.key)} controls className="max-h-full max-w-full" />
            ) : (
              <p className="text-sm text-white/80">No preview for this file. Download it to open it.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
