"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ArrowLeft, Check, Clock, FileUp, History, Lock, MessageSquarePlus, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import "./knowledge.css";

type Doc = {
  id: string; title: string; kind: string; tags: string[]; source: string; fileName: string | null; ownerId: string; audience: string; roleIds: string[];
  status: string; version: number; reviewEveryDays: number | null; reviewedAt: string; createdAt: string; updatedAt: string; stale: boolean; body?: string; canEdit?: boolean;
};
type Meta = {
  kinds: string[]; tags: string[]; roles: { id: string; name: string; builtin: string | null }[]; people: { id: string; name: string }[];
  me: { id: string; canPublish: boolean; canReview: boolean; canAsk: boolean; canSuggest: boolean; pending: number; stale: number };
};
type Hit = { docId: string; title: string; kind: string; heading: string; text: string };
type Suggestion = { id: string; docId: string | null; mode: string; title: string; body: string; reason: string; source: string; sourceRef: string | null; createdBy: string | null; status: string; createdAt: string };
type Gap = { id: string; question: string; count: number; lastAt: string };
type Version = { id: string; version: number; title: string; body: string; editedBy: string; note: string; createdAt: string };
type Tab = "library" | "ask" | "review" | "gaps" | "sources";
type Source = { id: string; folderId: string; folderName: string; kind: string; tags: string[]; audience: string; lastSyncAt: string | null; lastError: string | null; fileCount: number };

const KIND_LABEL: Record<string, string> = { sop: "SOP", policy: "Policy", process: "Process", product: "Product", pricing: "Pricing", customer: "Customer", vendor: "Vendor", glossary: "Glossary", faq: "FAQ", other: "Other" };
const AUD_LABEL: Record<string, string> = { everyone: "Everyone", members: "Members (no guests)", admins: "Admins only", roles: "Chosen roles" };

async function call<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `Request failed (${r.status})`);
  return d as T;
}
const ago = (s: string) => {
  const d = (Date.now() - new Date(s).getTime()) / 86400_000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 30 ? `${Math.floor(d)} days ago` : new Date(s).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
};

export default function KnowledgeApp({ initialDoc, initialTab }: { initialDoc: string | null; initialTab: string | null }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [tab, setTab] = useState<Tab>((["library", "ask", "review", "gaps", "sources"].includes(initialTab ?? "") ? initialTab : "library") as Tab);
  const [kind, setKind] = useState("");
  const [tag, setTag] = useState("");
  const [staleOnly, setStaleOnly] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Doc | null>(null);
  const [edit, setEdit] = useState<Partial<Doc> & { body: string } | null>(null);
  const [suggestFor, setSuggestFor] = useState<{ doc: Doc | null; title?: string } | null>(null);
  const [toast, setToast] = useState("");
  const [nonce, setNonce] = useState(0);
  const [hitsFor, setHitsFor] = useState<{ q: string; hits: Hit[] } | null>(null);
  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  }, []);

  // The list reloads when a filter changes or after an edit (load bumps the nonce).
  const load = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    const p = new URLSearchParams();
    if (kind) p.set("kind", kind);
    if (tag) p.set("tag", tag);
    if (staleOnly) p.set("stale", "1");
    let live = true;
    call<Meta & { docs: Doc[] }>(`/api/kb?${p}`)
      .then((d) => {
        if (!live) return;
        setMeta(d);
        setDocs(d.docs);
      })
      .catch((e) => flash(e.message));
    return () => {
      live = false;
    };
  }, [kind, tag, staleOnly, nonce, flash]);
  const openDoc = useCallback(
    (id: string) =>
      call<{ doc: Doc }>(`/api/kb/${id}`)
        .then((d) => {
          setOpen(d.doc);
          setEdit(null);
          setTab("library");
          window.history.replaceState(null, "", `/knowledge?doc=${id}`);
        })
        .catch((e) => flash(e.message)),
    [flash],
  );
  useEffect(() => {
    if (initialDoc) void openDoc(initialDoc);
  }, [initialDoc, openDoc]);

  // Passage search as you type (Library tab); results belong to the query they were for.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => call<{ hits: Hit[] }>(`/api/kb/search?q=${encodeURIComponent(term)}`).then((d) => setHitsFor({ q: term, hits: d.hits })).catch(() => setHitsFor({ q: term, hits: [] })), 200);
    return () => clearTimeout(t);
  }, [q]);
  const hits = q.trim().length < 2 ? null : hitsFor?.q === q.trim() ? hitsFor.hits : hitsFor?.hits ?? null;

  const person = (id: string) => meta?.people.find((p) => p.id === id)?.name ?? "Someone";
  const closeDoc = () => {
    setOpen(null);
    setEdit(null);
    window.history.replaceState(null, "", "/knowledge");
  };
  const newDoc = (title = "") => {
    setOpen(null);
    setEdit({ title, kind: "sop", tags: [], audience: "everyone", roleIds: [], status: "published", reviewEveryDays: 180, body: "" });
    setTab("library");
  };

  if (!meta) return <div className="kb-wrap"><p className="kb-muted" style={{ padding: 24 }}>Loading…</p></div>;
  const counts = (docs ?? []).reduce<Record<string, number>>((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {});

  return (
    <div className="kb-wrap">
      <header className="kb-head">
        <div>
          <h1>Knowledge</h1>
          <p className="kb-muted">Your company&apos;s SOPs, policies, prices and terms. Every AI in the suite checks these before acting on a request.</p>
        </div>
        <span style={{ flex: 1 }} />
        {meta.me.canPublish && <UploadButton onDone={(ids, failed) => { load(); if (failed.length) flash(failed.map((f) => `${f.name}: ${f.error}`).join(" · ")); else flash(`Added ${ids.length} ${ids.length === 1 ? "article" : "articles"}`); if (ids.length === 1) openDoc(ids[0]); }} />}
        {meta.me.canPublish ? <button className="ix-btn primary" onClick={() => newDoc()}><Plus size={14} /> New article</button>
          : meta.me.canSuggest && <button className="ix-btn primary" onClick={() => setSuggestFor({ doc: null })}><MessageSquarePlus size={14} /> Suggest an article</button>}
      </header>
      <nav className="kb-tabs" role="tablist">
        {([["library", "Library"], ...(meta.me.canAsk ? [["ask", "Ask AI"]] : []), ["review", meta.me.canReview ? `Review${meta.me.pending ? ` (${meta.me.pending})` : ""}` : "My suggestions"], ["gaps", "Unanswered"], ...(meta.me.canPublish ? [["sources", "Drive folders"]] : [])] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); if (k !== "library") closeDoc(); }}>{l}</button>
        ))}
      </nav>

      {tab === "library" && (
        edit ? (
          <Editor draft={edit} meta={meta} onCancel={() => (edit.id ? setEdit(null) : closeDoc())} flash={flash}
            onSaved={(d) => { load(); setEdit(null); setOpen(d); window.history.replaceState(null, "", `/knowledge?doc=${d.id}`); }} />
        ) : open ? (
          <DocView doc={open} meta={meta} person={person} flash={flash} onBack={closeDoc} onEdit={() => setEdit({ ...open, body: open.body ?? "" })}
            onChanged={(d) => { setOpen(d); load(); }} onDeleted={() => { closeDoc(); load(); }} onSuggest={() => setSuggestFor({ doc: open })} />
        ) : (
          <div className="kb-lib">
            <aside className="kb-filters">
              <div className="kb-search"><Search size={14} /><input placeholder="Search everything" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the knowledge base" />{q && <button onClick={() => setQ("")} aria-label="Clear"><X size={13} /></button>}</div>
              <div className="kb-flabel">Type</div>
              <button className={`kb-fitem${!kind ? " on" : ""}`} onClick={() => setKind("")}>All <span>{docs?.length ?? ""}</span></button>
              {meta.kinds.filter((k) => counts[k] || kind === k).map((k) => <button key={k} className={`kb-fitem${kind === k ? " on" : ""}`} onClick={() => setKind(kind === k ? "" : k)}>{KIND_LABEL[k]} <span>{counts[k] ?? 0}</span></button>)}
              {meta.me.stale > 0 && <button className={`kb-fitem warn${staleOnly ? " on" : ""}`} onClick={() => setStaleOnly(!staleOnly)}><AlertTriangle size={13} /> Needs review <span>{meta.me.stale}</span></button>}
              {meta.tags.length > 0 && (
                <>
                  <div className="kb-flabel">Tags</div>
                  <div className="kb-tagcloud">{meta.tags.map((t) => <button key={t} className={`ix-chip${tag === t ? "" : " muted"}`} onClick={() => setTag(tag === t ? "" : t)}>#{t}</button>)}</div>
                </>
              )}
            </aside>
            <section className="kb-list">
              {hits ? (
                <>
                  <div className="kb-muted kb-listhead">{hits.length ? `${hits.length} passages match “${q}”` : `Nothing matches “${q}”.`}</div>
                  {hits.map((h, i) => (
                    <button key={i} className="kb-hit" onClick={() => openDoc(h.docId)}>
                      <b>{h.title}{h.heading ? <span className="kb-muted"> › {h.heading}</span> : null}</b>
                      <span className="kb-snip">{h.text.slice(0, 280)}{h.text.length > 280 ? "…" : ""}</span>
                    </button>
                  ))}
                </>
              ) : docs === null ? <p className="kb-muted">Loading…</p> : docs.length === 0 ? (
                <div className="kb-empty">
                  <h3>{kind || tag || staleOnly ? "Nothing here" : "Start your company's knowledge base"}</h3>
                  {!(kind || tag || staleOnly) && <p className="kb-muted">Upload your SOPs, policies, price lists and product sheets (PDF, Word, Markdown, text or CSV), or write them here. The Builder, AI Chat and every app will use them, with sources.</p>}
                  {meta.me.canPublish && !(kind || tag || staleOnly) && <div className="kb-row"><button className="ix-btn primary" onClick={() => newDoc()}><Plus size={14} /> Write the first article</button></div>}
                </div>
              ) : docs.map((d) => (
                <button key={d.id} className="kb-card" onClick={() => openDoc(d.id)}>
                  <span className="kb-cardtop"><span className={`kb-kind k-${d.kind}`}>{KIND_LABEL[d.kind] ?? d.kind}</span>{d.status === "draft" && <span className="ix-chip muted">Draft</span>}{d.audience !== "everyone" && <Lock size={12} className="kb-muted" aria-label={AUD_LABEL[d.audience]} />}{d.stale && <span className="kb-stale"><AlertTriangle size={12} /> Review due</span>}</span>
                  <b>{d.title}</b>
                  <small className="kb-muted">{person(d.ownerId)} · v{d.version} · updated {ago(d.updatedAt)}{d.tags.length ? ` · ${d.tags.map((t) => `#${t}`).join(" ")}` : ""}</small>
                </button>
              ))}
            </section>
          </div>
        )
      )}
      {tab === "ask" && <AskView meta={meta} openDoc={openDoc} flash={flash} onSuggest={(title) => (meta.me.canPublish ? newDoc(title) : setSuggestFor({ doc: null, title }))} />}
      {tab === "review" && <ReviewView meta={meta} person={person} flash={flash} openDoc={openDoc} onChanged={load} />}
      {tab === "sources" && <SourcesView meta={meta} flash={flash} onChanged={load} />}
      {tab === "gaps" && <GapsView meta={meta} flash={flash} onWrite={(title) => (meta.me.canPublish ? newDoc(title) : setSuggestFor({ doc: null, title }))} />}
      {suggestFor && <SuggestDialog doc={suggestFor.doc} title={suggestFor.title} onClose={() => setSuggestFor(null)} flash={flash} />}
      {toast && <div className="ix-toast kb-toast" role="status">{toast}</div>}
    </div>
  );
}

function UploadButton({ onDone }: { onDone: (ids: string[], failed: { name: string; error: string }[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const go = async (files: FileList) => {
    setBusy(true);
    const fd = new FormData();
    for (const f of [...files].slice(0, 10)) fd.append("file", f);
    const r = await fetch("/api/kb/upload", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    onDone((d.docs ?? []).map((x: { id: string }) => x.id), d.failed ?? (r.ok ? [] : [{ name: "Upload", error: d.error ?? "failed" }]));
  };
  return (
    <>
      <button className="ix-btn" onClick={() => ref.current?.click()} disabled={busy}><FileUp size={14} /> {busy ? "Reading…" : "Upload"}</button>
      <input ref={ref} type="file" multiple hidden accept=".pdf,.docx,.md,.markdown,.txt,.csv,.tsv,.html,.htm,.json" onChange={(e) => { if (e.target.files?.length) go(e.target.files); e.target.value = ""; }} />
    </>
  );
}

function DocView({ doc, meta, person, flash, onBack, onEdit, onChanged, onDeleted, onSuggest }: {
  doc: Doc; meta: Meta; person: (id: string) => string; flash: (m: string) => void; onBack: () => void; onEdit: () => void; onChanged: (d: Doc) => void; onDeleted: () => void; onSuggest: () => void;
}) {
  const [hist, setHist] = useState<Version[] | null>(null);
  const [peek, setPeek] = useState<Version | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const patch = async (b: Record<string, unknown>, msg: string) => {
    try {
      const d = await call<{ doc: Doc }>(`/api/kb/${doc.id}`, { method: "PATCH", body: b });
      onChanged({ ...d.doc, body: d.doc.body });
      flash(msg);
      if (hist) setHist((await call<{ versions: Version[] }>(`/api/kb/${doc.id}/versions`)).versions);
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const roles = doc.audience === "roles" ? meta.roles.filter((r) => doc.roleIds.includes(r.id)).map((r) => r.name).join(", ") : "";
  return (
    <article className="kb-doc">
      <div className="kb-row">
        <button className="ix-btn" onClick={onBack}><ArrowLeft size={14} /> Library</button>
        <span style={{ flex: 1 }} />
        {doc.canEdit && <button className="ix-btn" onClick={onEdit}>Edit</button>}
        {doc.canEdit && doc.reviewEveryDays && <button className="ix-btn" onClick={() => patch({ reviewed: true }, "Marked as reviewed")}><Check size={14} /> Mark reviewed</button>}
        {!doc.canEdit && meta.me.canSuggest && <button className="ix-btn" onClick={onSuggest}><MessageSquarePlus size={14} /> Suggest a change</button>}
        <button className={`ix-btn${hist ? " on" : ""}`} onClick={async () => setHist(hist ? null : (await call<{ versions: Version[] }>(`/api/kb/${doc.id}/versions`)).versions)}><History size={14} /> History</button>
        {doc.canEdit && (doc.status === "archived"
          ? <button className="ix-btn" onClick={() => patch({ status: "published" }, "Restored from the archive")}>Unarchive</button>
          : <button className="ix-btn" onClick={() => patch({ status: "archived" }, "Archived: the AI no longer uses it")}>Archive</button>)}
        {meta.me.canPublish && <button className="ix-btn danger" onClick={() => setConfirmDel(true)} aria-label="Delete article"><Trash2 size={14} /></button>}
      </div>
      {doc.stale && <div className="kb-banner"><AlertTriangle size={14} /> Due for review: last reviewed {ago(doc.reviewedAt)} (every {doc.reviewEveryDays} days). Check it&apos;s still right.</div>}
      {doc.status !== "published" && <div className="kb-banner muted">{doc.status === "draft" ? "Draft: only editors see it, and the AI doesn't use it yet." : "Archived: the AI doesn't use it."}</div>}
      <h2 className="kb-title">{doc.title}</h2>
      <div className="kb-meta">
        <span className={`kb-kind k-${doc.kind}`}>{KIND_LABEL[doc.kind]}</span>
        <span>Owner {person(doc.ownerId)}</span>
        <span>v{doc.version} · updated {ago(doc.updatedAt)}</span>
        <span>{doc.audience !== "everyone" && <Lock size={12} />} {AUD_LABEL[doc.audience]}{roles ? `: ${roles}` : ""}</span>
        {doc.reviewEveryDays ? <span><Clock size={12} /> Review every {doc.reviewEveryDays} days</span> : null}
        {doc.fileName && <span>From {doc.fileName}</span>}
        {doc.tags.map((t) => <span key={t} className="ix-chip muted">#{t}</span>)}
      </div>
      <div className="kb-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{peek ? peek.body : doc.body ?? ""}</ReactMarkdown></div>
      {hist && (
        <aside className="kb-hist">
          <b>History</b>
          <button className={`kb-ver${!peek ? " on" : ""}`} onClick={() => setPeek(null)}>v{doc.version} · current · {ago(doc.updatedAt)}</button>
          {hist.length === 0 && <span className="kb-muted">No earlier versions.</span>}
          {hist.map((h) => (
            <div key={h.id} className={`kb-ver${peek?.id === h.id ? " on" : ""}`}>
              <button onClick={() => setPeek(h)}>v{h.version} · {ago(h.createdAt)} · {person(h.editedBy)} changed it{h.note ? ` (${h.note})` : ""}</button>
              {doc.canEdit && <button className="ix-btn" onClick={() => { setPeek(null); patch({ restore: h.version }, `Restored version ${h.version}`); }}>Restore</button>}
            </div>
          ))}
        </aside>
      )}
      {confirmDel && (
        <div className="kb-scrim" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDel(false)}>
          <div className="kb-dialog" role="dialog" aria-label="Delete article">
            <h3>Delete “{doc.title}”?</h3>
            <p className="kb-muted">This removes it and its history for good. Archive instead to keep it.</p>
            <div className="kb-row"><span style={{ flex: 1 }} /><button className="ix-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
              <button className="ix-btn danger" onClick={async () => { try { await call(`/api/kb/${doc.id}`, { method: "DELETE" }); flash("Deleted"); onDeleted(); } catch (e) { flash((e as Error).message); } }}>Delete</button></div>
          </div>
        </div>
      )}
    </article>
  );
}

function Editor({ draft, meta, onCancel, onSaved, flash }: { draft: Partial<Doc> & { body: string }; meta: Meta; onCancel: () => void; onSaved: (d: Doc) => void; flash: (m: string) => void }) {
  const [d, setD] = useState(draft);
  const [tags, setTags] = useState((draft.tags ?? []).join(", "));
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = { title: d.title, kind: d.kind, body: d.body, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), audience: d.audience, roleIds: d.roleIds, status: d.status, reviewEveryDays: d.reviewEveryDays ?? null, ownerId: d.ownerId };
    try {
      const r = d.id ? await call<{ doc: Doc }>(`/api/kb/${d.id}`, { method: "PATCH", body }) : await call<{ doc: Doc }>("/api/kb", { body });
      flash(d.id ? "Saved" : "Article added");
      onSaved(r.doc);
    } catch (e) {
      flash((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="kb-editor">
      <input className="kb-titlein" placeholder="Title, e.g. Dispatch process" value={d.title ?? ""} onChange={(e) => setD({ ...d, title: e.target.value })} aria-label="Title" autoFocus />
      <div className="kb-fields">
        <label>Type<select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })}>{meta.kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
        <label>Tags<input placeholder="dispatch, warehouse" value={tags} onChange={(e) => setTags(e.target.value)} /></label>
        <label>Who can read it<select value={d.audience} onChange={(e) => setD({ ...d, audience: e.target.value })}>{Object.entries(AUD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Review every<select value={String(d.reviewEveryDays ?? "")} onChange={(e) => setD({ ...d, reviewEveryDays: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Never</option><option value="30">30 days</option><option value="90">3 months</option><option value="180">6 months</option><option value="365">Year</option></select></label>
        <label>Owner<select value={d.ownerId ?? meta.me.id} onChange={(e) => setD({ ...d, ownerId: e.target.value })}>{meta.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Status<select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })}><option value="published">Published</option><option value="draft">Draft</option></select></label>
      </div>
      {d.audience === "roles" && (
        <div className="kb-roles">
          {meta.roles.map((r) => <label key={r.id}><input type="checkbox" checked={(d.roleIds ?? []).includes(r.id)} onChange={(e) => setD({ ...d, roleIds: e.target.checked ? [...(d.roleIds ?? []), r.id] : (d.roleIds ?? []).filter((x) => x !== r.id) })} /> {r.name}</label>)}
        </div>
      )}
      <div className="kb-row"><span className="kb-muted" style={{ fontSize: 12 }}>Markdown: # headings split it into sections the AI can cite. Tables, lists and **bold** work.</span><span style={{ flex: 1 }} />
        <button className={`ix-btn${preview ? " on" : ""}`} onClick={() => setPreview(!preview)}>{preview ? "Write" : "Preview"}</button></div>
      {preview ? <div className="kb-md kb-prev"><ReactMarkdown remarkPlugins={[remarkGfm]}>{d.body}</ReactMarkdown></div>
        : <textarea className="kb-body" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} aria-label="Article text" placeholder={"# Purpose\n\n# Steps\n1. …\n\n# Who to ask"} />}
      <div className="kb-row"><span style={{ flex: 1 }} /><button className="ix-btn" onClick={onCancel}>Cancel</button><button className="ix-btn primary" disabled={busy || !d.title?.trim() || !d.body.trim()} onClick={save}>{busy ? "Saving…" : d.id ? "Save new version" : "Publish"}</button></div>
    </div>
  );
}

function AskView({ meta, openDoc, flash, onSuggest }: { meta: Meta; openDoc: (id: string) => void; flash: (m: string) => void; onSuggest: (title: string) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ q: string; answer: string; found: boolean; sources: { n: number; docId: string; title: string; heading: string; platform?: boolean }[] } | null>(null);
  const go = async () => {
    if (q.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      const r = await call<{ answer: string; found: boolean; sources: { n: number; docId: string; title: string; heading: string; platform?: boolean }[] }>("/api/kb/ask", { body: { question: q } });
      setRes({ q, ...r });
    } catch (e) {
      flash((e as Error).message);
    }
    setBusy(false);
  };
  // [n] in the answer becomes a link to its source.
  const answer = useMemo(() => (res?.answer ?? "").replace(/\[(\d+)\]/g, (m, n) => { const s = res?.sources.find((x) => x.n === Number(n)); return s && !s.platform ? `[[${n}]](#src-${s.docId})` : m; }), [res]);
  return (
    <div className="kb-ask">
      <div className="kb-askbox">
        <Sparkles size={16} className="kb-accent" />
        <input placeholder="Ask anything about how we work, e.g. What's our credit period for distributors?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} aria-label="Ask a question" autoFocus />
        <button className="ix-btn primary" onClick={go} disabled={busy || q.trim().length < 3}>{busy ? "Reading…" : "Ask"}</button>
      </div>
      <p className="kb-muted" style={{ fontSize: 12 }}>Answers use your company&apos;s articles and the project&apos;s knowledge first, with their sources, plus general knowledge for the rest.</p>
      {res && (
        <div className="kb-answer">
          <div className="kb-muted" style={{ fontSize: 12 }}>{res.q}</div>
          {res.answer && (
            <>
              <div className="kb-md" onClick={(e) => { const a = (e.target as HTMLElement).closest("a"); const id = a?.getAttribute("href")?.replace("#src-", ""); if (id && a?.getAttribute("href")?.startsWith("#src-")) { e.preventDefault(); openDoc(id); } }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
              </div>
              {res.sources.length > 0 && <div className="kb-sources"><b>Sources</b>{(res.sources.some((s) => res.answer.includes(`[${s.n}]`)) ? res.sources.filter((s) => res.answer.includes(`[${s.n}]`)) : res.sources).map((s) => (s.platform ? <span key={s.n} className="kb-src-static" title="Project knowledge">[{s.n}] {s.title}{s.heading ? ` › ${s.heading}` : ""}</span> : <button key={s.n} onClick={() => openDoc(s.docId)}>[{s.n}] {s.title}{s.heading ? ` › ${s.heading}` : ""}</button>))}</div>}
            </>
          )}
          {!res.found && (
            <div className="kb-banner muted">No company article covers this yet, so the answer above is general. It&apos;s been added to Unanswered.{(meta.me.canPublish || meta.me.canSuggest) && <button className="ix-btn" onClick={() => onSuggest(res.q)}>{meta.me.canPublish ? "Write the answer" : "Suggest an article"}</button>}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewView({ meta, person, flash, openDoc, onChanged }: { meta: Meta; person: (id: string) => string; flash: (m: string) => void; openDoc: (id: string) => void; onChanged: () => void }) {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  const [edits, setEdits] = useState<Record<string, { title: string; body: string }>>({});
  const load = useCallback(() => call<{ suggestions: Suggestion[] }>(`/api/kb/suggestions?status=${status}`).then((d) => setRows(d.suggestions)).catch((e) => flash(e.message)), [status, flash]);
  useEffect(() => { load(); }, [load]);
  const act = async (s: Suggestion, action: "approve" | "reject") => {
    try {
      await call(`/api/kb/suggestions/${s.id}`, { body: { action, ...(edits[s.id] ?? {}) } });
      flash(action === "approve" ? "Approved and published" : "Rejected");
      load();
      onChanged();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const SRC: Record<string, string> = { builder: "Builder agent", assistant: "AI Chat", person: "Suggested by" };
  return (
    <div className="kb-review">
      <div className="kb-row">
        <p className="kb-muted" style={{ margin: 0 }}>{meta.me.canReview ? "What the AI learned and what people suggested. Nothing reaches the knowledge base until it's approved here." : "Your suggestions and what happened to them."}</p>
        <span style={{ flex: 1 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show"><option value="pending">Waiting</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
      </div>
      {rows === null ? <p className="kb-muted">Loading…</p> : rows.length === 0 && <p className="kb-muted">{status === "pending" ? "Nothing waiting for review." : "None yet."}</p>}
      {rows?.map((s) => {
        const e = edits[s.id] ?? { title: s.title, body: s.body };
        const editable = meta.me.canReview && s.status === "pending";
        return (
          <div key={s.id} className="kb-sugg">
            <div className="kb-row">
              <span className="ix-chip">{s.mode === "new" ? "New article" : s.mode === "replace" ? "Replace article" : "Add to article"}</span>
              <small className="kb-muted">{SRC[s.source] ?? "From"} {s.source === "person" || s.createdBy ? person(s.createdBy ?? "") : ""} · {ago(s.createdAt)}</small>
              {s.docId && <button className="ix-btn" onClick={() => openDoc(s.docId!)}>Open article</button>}
            </div>
            {s.reason && <p className="kb-muted" style={{ margin: 0, fontSize: 12.5 }}>Why: {s.reason}</p>}
            {editable ? (
              <>
                <input className="kb-in" value={e.title} onChange={(x) => setEdits({ ...edits, [s.id]: { ...e, title: x.target.value } })} aria-label="Title" />
                <textarea className="kb-in" rows={5} value={e.body} onChange={(x) => setEdits({ ...edits, [s.id]: { ...e, body: x.target.value } })} aria-label="Text" />
                <div className="kb-row"><span style={{ flex: 1 }} /><button className="ix-btn" onClick={() => act(s, "reject")}>Reject</button><button className="ix-btn primary" onClick={() => act(s, "approve")}><Check size={14} /> Approve</button></div>
              </>
            ) : (
              <>
                <b>{s.title}</b>
                <div className="kb-md small"><ReactMarkdown remarkPlugins={[remarkGfm]}>{s.body}</ReactMarkdown></div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GapsView({ meta, flash, onWrite }: { meta: Meta; flash: (m: string) => void; onWrite: (title: string) => void }) {
  const [rows, setRows] = useState<Gap[] | null>(null);
  const load = useCallback(() => call<{ gaps: Gap[] }>("/api/kb/gaps").then((d) => setRows(d.gaps)).catch((e) => flash(e.message)), [flash]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="kb-review">
      <p className="kb-muted" style={{ margin: 0 }}>Questions people and the AI asked that the knowledge base couldn&apos;t answer. Writing these up makes every AI in the suite more accurate.</p>
      {rows === null ? <p className="kb-muted">Loading…</p> : rows.length === 0 && <p className="kb-muted">No unanswered questions.</p>}
      {rows?.map((g) => (
        <div key={g.id} className="kb-gap">
          <span style={{ flex: 1 }}>{g.question}</span>
          <small className="kb-muted">asked {g.count}× · {ago(g.lastAt)}</small>
          {(meta.me.canPublish || meta.me.canSuggest) && <button className="ix-btn" onClick={() => onWrite(g.question)}>{meta.me.canPublish ? "Write it" : "Suggest"}</button>}
          {(meta.me.canPublish || meta.me.canReview) && <button className="ix-btn" onClick={async () => { await call("/api/kb/gaps", { body: { id: g.id } }).catch((e) => flash(e.message)); load(); }}>Dismiss</button>}
        </div>
      ))}
    </div>
  );
}

function SuggestDialog({ doc, title: t0, onClose, flash }: { doc: Doc | null; title?: string; onClose: () => void; flash: (m: string) => void }) {
  const [title, setTitle] = useState(t0 ?? (doc ? `Update: ${doc.title}` : ""));
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const send = async () => {
    try {
      await call("/api/kb/suggestions", { body: { docId: doc?.id ?? null, mode: "append", title, body, reason } });
      flash("Sent for review");
      onClose();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  return (
    <div className="kb-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kb-dialog wide" role="dialog" aria-label="Suggest an update">
        <h3>{doc ? `Suggest a change to “${doc.title}”` : "Suggest an article"}</h3>
        <input className="kb-in" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" autoFocus />
        <textarea className="kb-in" rows={7} placeholder="What should it say? (Markdown)" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Text" />
        <input className="kb-in" placeholder="Why, or where this comes from (optional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
        <div className="kb-row"><span className="kb-muted" style={{ fontSize: 12 }}>A reviewer approves it before it&apos;s used.</span><span style={{ flex: 1 }} /><button className="ix-btn" onClick={onClose}>Cancel</button><button className="ix-btn primary" disabled={!title.trim() || !body.trim()} onClick={send}>Send for review</button></div>
      </div>
    </div>
  );
}

function SourcesView({ meta, flash, onChanged }: { meta: Meta; flash: (m: string) => void; onChanged: () => void }) {
  const [data, setData] = useState<{ sources: Source[]; googleConnected: boolean; googleEmail: string | null } | null>(null);
  const [folder, setFolder] = useState("");
  const [kind, setKind] = useState("sop");
  const [tags, setTags] = useState("");
  const [audience, setAudience] = useState("everyone");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => call<{ sources: Source[]; googleConnected: boolean; googleEmail: string | null }>("/api/kb/sources").then(setData).catch((e) => flash(e.message)), [flash]);
  useEffect(() => { load(); }, [load]);
  const report = (r: { added: number; updated: number; archived: number; failed: { name: string; error: string }[] }) =>
    flash(`${r.added} added, ${r.updated} updated, ${r.archived} archived${r.failed.length ? `, ${r.failed.length} couldn't be read` : ""}`);
  const add = async () => {
    setBusy("add");
    try {
      report(await call("/api/kb/sources", { body: { folder, kind, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), audience } }));
      setFolder("");
      load();
      onChanged();
    } catch (e) {
      flash((e as Error).message);
    }
    setBusy(null);
  };
  if (!data) return <p className="kb-muted">Loading…</p>;
  return (
    <div className="kb-review">
      <p className="kb-muted" style={{ margin: 0 }}>Keep a Google Drive folder (say, &quot;Company SOPs&quot;) in the knowledge base. Docs, PDFs, Word files, Sheets and text files in it become articles; changes are picked up every 30 minutes, and removed files are archived.</p>
      {!data.googleConnected ? (
        <div className="kb-banner muted">Connect Google Drive first. <a className="ix-btn" href={`/api/google/connect?back=${encodeURIComponent("/knowledge?tab=sources")}`}>Connect Google</a></div>
      ) : (
        <div className="kb-sugg">
          <small className="kb-muted">Reading as {data.googleEmail}</small>
          <input className="kb-in" placeholder="Drive folder link, e.g. https://drive.google.com/drive/folders/…" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder link" />
          <div className="kb-fields">
            <label>Type<select value={kind} onChange={(e) => setKind(e.target.value)}>{meta.kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
            <label>Tags<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="sop, operations" /></label>
            <label>Who can read<select value={audience} onChange={(e) => setAudience(e.target.value)}><option value="everyone">Everyone</option><option value="members">Members (no guests)</option><option value="admins">Admins only</option></select></label>
          </div>
          <div className="kb-row"><span style={{ flex: 1 }} /><button className="ix-btn primary" disabled={!folder.trim() || busy === "add"} onClick={add}>{busy === "add" ? "Reading the folder…" : "Connect folder"}</button></div>
        </div>
      )}
      {data.sources.map((s) => (
        <div key={s.id} className="kb-gap">
          <span style={{ flex: 1 }}><b>{s.folderName}</b> <small className="kb-muted">· {s.fileCount} files · {KIND_LABEL[s.kind]}{s.tags.length ? ` · ${s.tags.map((t) => `#${t}`).join(" ")}` : ""} · {s.lastSyncAt ? `read ${ago(s.lastSyncAt)}` : "not read yet"}</small>
            {s.lastError && <small className="kb-stale" style={{ display: "block", marginLeft: 0 }}><AlertTriangle size={12} /> {s.lastError}</small>}</span>
          <button className="ix-btn" disabled={busy === s.id} onClick={async () => { setBusy(s.id); try { report(await call(`/api/kb/sources/${s.id}`, { body: {} })); load(); onChanged(); } catch (e) { flash((e as Error).message); } setBusy(null); }}>{busy === s.id ? "Syncing…" : "Sync now"}</button>
          <button className="ix-btn" onClick={async () => { await call(`/api/kb/sources/${s.id}?keep=1`, { method: "DELETE" }).catch((e) => flash(e.message)); load(); }}>Disconnect</button>
        </div>
      ))}
    </div>
  );
}
