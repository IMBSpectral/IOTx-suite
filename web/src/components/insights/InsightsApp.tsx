"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ECharts } from "echarts";
import {
  AlertTriangle, ArrowDown, ArrowUp, BarChart3, ChevronLeft, Database, Download, Eye, FileSpreadsheet, FileText, Filter, GripVertical, Lightbulb,
  Loader2, Maximize2, MessageSquare, MoreHorizontal, Network, Plus, Search, Send, Sparkles, Table2, Trash2, TrendingDown, TrendingUp, Upload, X,
} from "lucide-react";
import Chart from "./Chart";
import DataMap, { type MapLink } from "./DataMap";
import { chartHeight, fmt, isIdName, isNumType, label, type Data, type Widget } from "./chart-options";
import "./insights.css";

type Col = { name: string; type: string };
type Table = { name: string; source: string; part?: string; rows: number; columns: Col[]; title?: string; derived?: boolean };
type Source = { id: string; name: string; size: number; kind: string; at: string; tables: string[]; textChars?: number; note?: string };
type ChatMsg = { role: "user" | "assistant"; text: string; at: string; steps?: string[]; questions?: string[] };
type Analysis = { id: string; name: string; updatedAt: string; sources: Source[]; tables: Table[]; board: Widget[]; chat: ChatMsg[]; questions?: string[]; links?: MapLink[] };
type Summary = { id: string; name: string; updatedAt: string; sources: number; tables: number; widgets: number };
type Filter = { column: string; table?: string; values?: string[]; label?: string };
type Result = (Data & { meta?: Record<string, unknown> }) | { error: string };

const ACCEPT = ".xlsx,.xlsm,.csv,.tsv,.json,.ndjson,.jsonl,.parquet,.docx,.pptx,.pdf,.md,.markdown,.txt,.html,.htm,.xml,.yaml,.yml,.log";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `Request failed (${r.status})`);
  return j as T;
}

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export default function InsightsApp({ initial }: { initial: string | null }) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [a, setA] = useState<Analysis | null>(null);
  const [openId, setOpenId] = useState<string | null>(initial);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => api<{ analyses: Summary[] }>("/api/insights").then((r) => setList(r.analyses)).catch((e) => setError(e.message)), []);
  useEffect(() => void loadList(), [loadList]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (openId) url.searchParams.set("a", openId);
    else url.searchParams.delete("a");
    window.history.replaceState(null, "", url);
    if (!openId) {
      setA(null);
      return;
    }
    api<{ analysis: Analysis }>(`/api/insights/${openId}`)
      .then((r) => setA(r.analysis))
      .catch((e) => {
        setError(e.message);
        setOpenId(null);
      });
  }, [openId]);

  // A new analysis from files dropped on the start page: make it, add the files, open it, start the analyst.
  const [creating, setCreating] = useState(false);
  const [autoStart, setAutoStart] = useState<string | null>(null);
  const startWith = async (files: File[]) => {
    if (!files.length) return;
    setCreating(true);
    setError(null);
    try {
      const { analysis } = await api<{ analysis: Analysis }>("/api/insights", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: files[0].name.replace(/\.[^.]+$/, "") }) });
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const r = await api<{ analysis: Analysis; errors: string[] }>(`/api/insights/${analysis.id}/files`, { method: "POST", body: fd });
      if (r.errors.length) setError(r.errors.join(" "));
      setA(r.analysis);
      setOpenId(analysis.id);
      if (r.analysis.sources.length) setAutoStart(`I've added ${files.map((f) => f.name).join(", ")}. Analyse it and build the first board.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  if (openId && a?.id === openId)
    return (
      <Workspace
        key={a.id}
        a={a}
        setA={setA}
        autoStart={autoStart}
        clearAutoStart={() => setAutoStart(null)}
        onBack={() => {
          setOpenId(null);
          void loadList();
        }}
      />
    );

  return (
    <div className="ins-home">
      <div className="ins-hero">
        <div className="ins-hero-badge">
          <Sparkles size={14} /> AI analyst
        </div>
        <h1>Insights</h1>
        <p>Drop in any data: spreadsheets, CSVs, Word, PDF or slides. The analyst reads all of it, builds a live board and talks it through with you.</p>
        <DropZone busy={creating || (!!openId && !a)} onFiles={startWith} big />
        {error && (
          <div className="ins-error">
            <AlertTriangle size={14} /> {error}
          </div>
        )}
      </div>
      <div className="ins-recent">
        <h2>Your analyses</h2>
        {list === null ? (
          <div className="ins-muted">
            <Loader2 size={14} className="ins-spin" /> Loading…
          </div>
        ) : list.length === 0 ? (
          <div className="ins-muted">None yet. Drop a file above to start.</div>
        ) : (
          <div className="ins-cards">
            {list.map((s) => (
              <button key={s.id} className="ins-card" onClick={() => setOpenId(s.id)}>
                <div className="ins-card-icon">
                  <BarChart3 size={18} />
                </div>
                <b>{s.name}</b>
                <span className="ins-muted">
                  {s.sources} file{s.sources === 1 ? "" : "s"} · {s.tables} table{s.tables === 1 ? "" : "s"} · {s.widgets} chart{s.widgets === 1 ? "" : "s"}
                </span>
                <span className="ins-muted ins-small">{ago(s.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DropZone({ onFiles, busy, big }: { onFiles: (f: File[]) => void; busy?: boolean; big?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`ins-drop${big ? " big" : ""}${over ? " over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!busy) onFiles([...e.dataTransfer.files]);
      }}
      onClick={() => !busy && input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {busy ? <Loader2 size={big ? 28 : 18} className="ins-spin" /> : <Upload size={big ? 28 : 18} />}
      <div>
        <b>{busy ? "Reading your files…" : big ? "Drop files here or click to choose" : "Add data"}</b>
        {big && <span>Excel · CSV · JSON · Parquet · Word · PowerPoint · PDF · Markdown · text, up to 100 MB each</span>}
      </div>
    </div>
  );
}

// ─── One analysis: board, data, files, and the analyst ───────────────────────

type Live = { text: string; thought: string; steps: string[]; busy: boolean };

function Workspace({ a, setA, onBack, autoStart, clearAutoStart }: { a: Analysis; setA: (a: Analysis) => void; onBack: () => void; autoStart: string | null; clearAutoStart: () => void }) {
  const [tab, setTab] = useState<"board" | "data" | "map" | "files">("board");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [loading, setLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [live, setLive] = useState<Live | null>(null);
  const [questions, setQuestions] = useState<string[]>(a.questions ?? []);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const aRef = useRef(a);
  aRef.current = a;

  // Chart data: every chart with the current filters. Re-run when the board's queries or the filters change.
  const boardKey = a.board.map((w) => `${w.id}:${w.sql ?? ""}`).join("|");
  const seq = useRef(0);
  const refresh = useCallback(
    async (only?: string[]) => {
      const n = ++seq.current;
      setLoading(true);
      try {
        const r = await api<{ results: Record<string, Result> }>(`/api/insights/${aRef.current.id}/data`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ widgets: only, filters }),
        });
        if (n === seq.current || only) setResults((old) => (only ? { ...old, ...r.results } : r.results));
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [filters],
  );
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, refresh]);

  const resolveFilter = (w: Widget, value: string): Filter | null => {
    const spec = w.filter || w.x;
    if (!spec) return null;
    const t = a.tables.find((t) => spec.startsWith(`${t.name}.`) && t.columns.some((c) => c.name === spec.slice(t.name.length + 1)));
    const column = t ? spec.slice(t.name.length + 1) : spec;
    if (!a.tables.some((t) => t.columns.some((c) => c.name.toLowerCase() === column.toLowerCase()))) return null;
    return { column, table: t?.name, values: [value] };
  };
  const pick = (w: Widget, value: string) => {
    const f = resolveFilter(w, value);
    if (!f) {
      setNotice(`"${w.title}" can't filter the board: its axis isn't a column in the data.`);
      return;
    }
    setFilters((old) => {
      const same = old.find((x) => x.column.toLowerCase() === f.column.toLowerCase() && x.table === f.table);
      if (!same) return [...old, f];
      const vals = same.values ?? [];
      const next = vals.includes(value) ? vals.filter((v) => v !== value) : [...vals, value];
      return next.length ? old.map((x) => (x === same ? { ...x, values: next } : x)) : old.filter((x) => x !== same);
    });
  };

  const patch = async (body: object) => {
    const r = await api<{ analysis: Analysis }>(`/api/insights/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setA(r.analysis);
  };
  const setBoard = (board: Widget[]) => {
    setA({ ...a, board });
    void patch({ board: board.map((w) => ({ id: w.id, size: w.size, title: w.title })) }).catch((e) => setNotice(e.message));
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const r = await api<{ analysis: Analysis; errors: string[] }>(`/api/insights/${a.id}/files`, { method: "POST", body: fd });
      setA(r.analysis);
      if (r.errors.length) setNotice(r.errors.join(" "));
      const ok = files.filter((f) => r.analysis.sources.some((s) => s.name === f.name));
      if (ok.length) void send(r.analysis.board.length ? `I've added ${ok.map((f) => f.name).join(", ")}. Look at what's new and update the board.` : `I've added ${ok.map((f) => f.name).join(", ")}. Analyse it and build the first board.`, r.analysis);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  // The analyst: stream its reply, steps and board changes as they happen.
  const send = async (text: string, base?: Analysis) => {
    const cur = base ?? aRef.current;
    if (!text.trim() || live?.busy) return;
    setChatOpen(true);
    setQuestions([]);
    const at = new Date().toISOString();
    let working: Analysis = { ...cur, chat: [...cur.chat, { role: "user", text, at }] };
    setA(working);
    const state: Live = { text: "", thought: "", steps: [], busy: true };
    setLive({ ...state });
    let finished = false;
    let serverError: string | null = null;
    try {
      const r = await fetch(`/api/insights/${cur.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!r.ok || !r.body) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "The analyst couldn't start.");
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let painted = 0;
      const paint = (force = false) => {
        if (!force && Date.now() - painted < 80) return;
        painted = Date.now();
        setLive({ ...state, steps: [...state.steps] });
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type: string; [k: string]: unknown };
          if (ev.type === "text") state.text += ev.delta as string;
          else if (ev.type === "thought") state.thought = (state.thought + (ev.delta as string)).slice(-600);
          else if (ev.type === "step") state.steps.push(ev.label as string);
          else if (ev.type === "board") {
            working = { ...working, board: ev.board as Widget[] };
            setA(working);
          } else if (ev.type === "tables") {
            working = { ...working, tables: ev.tables as Table[] };
            setA(working);
          } else if (ev.type === "name") {
            working = { ...working, name: ev.name as string };
            setA(working);
          } else if (ev.type === "questions") setQuestions(ev.questions as string[]);
          else if (ev.type === "error") {
            serverError = ev.error as string;
            throw new Error(serverError);
          } else if (ev.type === "done") {
            finished = true;
            working = { ...working, chat: [...working.chat, { role: "assistant", text: (ev.reply as string) || state.text, at: new Date().toISOString(), steps: ev.steps as string[], questions: ev.questions as string[] }] };
            setA(working);
          }
          paint();
        }
      }
      if (!finished) throw new Error("connection closed");
    } catch (e) {
      // The connection dropped (network, proxy, laptop sleep) but the analyst keeps working on the
      // server and saves its result: wait for it and show it, instead of an error.
      const recovered = !serverError && (await recover(cur.id, state));
      if (!recovered) {
        const msg = serverError ?? "The connection to the analyst was lost. Reload the page to see whether it finished.";
        setNotice(msg);
        working = { ...working, chat: [...working.chat, { role: "assistant", text: `⚠️ ${msg}`, at: new Date().toISOString() }] };
        setA(working);
      }
    } finally {
      setLive(null);
    }
  };

  /** After a dropped connection: poll until the server says the turn is over, then load what it saved. */
  const recover = async (id: string, state: Live) => {
    state.steps.push("Connection dropped: the analyst is still working, reconnecting…");
    setLive({ ...state, steps: [...state.steps] });
    for (let i = 0; i < 225; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const r = await api<{ analysis: Analysis; busy: boolean }>(`/api/insights/${id}`).catch(() => null);
      if (!r) continue;
      setA(r.analysis);
      if (!r.busy) {
        setQuestions(r.analysis.questions ?? []);
        return true;
      }
    }
    return false;
  };

  // Once, even when React runs effects twice (development) or the parent re-renders.
  const started = useRef(false);
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      clearAutoStart();
      void send(autoStart);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exp = expanded ? a.board.find((w) => w.id === expanded) : null;

  return (
    <div className={`ins-ws${chatOpen ? " chat-open" : ""}`}>
      <div className="ins-main">
        <header className="ins-top">
          <button className="ins-icon-btn" onClick={onBack} title="All analyses">
            <ChevronLeft size={18} />
          </button>
          <NameField value={a.name} onSave={(name) => void patch({ name }).catch((e) => setNotice(e.message))} />
          <nav className="ins-tabs">
            {(
              [
                ["board", "Board", BarChart3],
                ["data", "Data", Table2],
                ["map", "Map", Network],
                ["files", "Files", FileText],
              ] as const
            ).map(([id, name, Icon]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                <Icon size={14} /> {name}
                {id === "files" && <span className="ins-count">{a.sources.length}</span>}
              </button>
            ))}
          </nav>
          <div className="ins-top-right">
            {loading && <Loader2 size={14} className="ins-spin ins-muted" />}
            <label className="ix-btn ins-add">
              {uploading ? <Loader2 size={14} className="ins-spin" /> : <Plus size={14} />} Add data
              <input type="file" multiple hidden accept={ACCEPT} onChange={(e) => (void addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
            </label>
            {!chatOpen && (
              <button className="ix-btn" onClick={() => setChatOpen(true)}>
                <Sparkles size={14} /> Analyst
              </button>
            )}
          </div>
        </header>

        {filters.length > 0 && (
          <div className="ins-filters">
            <Filter size={13} />
            {filters.map((f, i) => (
              <span key={i} className="ins-chip">
                <b>{f.column}</b> {f.values?.join(", ")}
                <button onClick={() => setFilters(filters.filter((x) => x !== f))} aria-label="Remove filter">
                  <X size={12} />
                </button>
              </span>
            ))}
            <button className="ins-link" onClick={() => setFilters([])}>
              Clear all
            </button>
          </div>
        )}
        {notice && (
          <div className="ins-notice">
            <AlertTriangle size={14} /> <span>{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        )}

        <div className="ins-body">
          {tab === "board" && (
            <Board
              a={a}
              results={results}
              filters={filters}
              busy={!!live?.busy}
              onPick={pick}
              onExpand={setExpanded}
              setBoard={setBoard}
              onAsk={(t) => void send(t)}
              onFiles={addFiles}
              uploading={uploading}
            />
          )}
          {tab === "data" && <DataView a={a} filters={filters} />}
          {tab === "map" && <DataMap tables={a.tables} links={a.links ?? []} onLink={(link) => patch({ link }).catch((e) => setNotice(e.message))} />}
          {tab === "files" && (
            <FilesView
              a={a}
              onRemove={async (id) => {
                const r = await api<{ analysis: Analysis }>(`/api/insights/${a.id}/files?source=${id}`, { method: "DELETE" });
                setA(r.analysis);
              }}
              onFiles={addFiles}
              uploading={uploading}
            />
          )}
        </div>
      </div>

      {chatOpen && <ChatPanel a={a} live={live} questions={questions} onSend={(t) => void send(t)} onClose={() => setChatOpen(false)} />}

      {exp && <Expanded w={exp} r={results[exp.id]} onClose={() => setExpanded(null)} onPick={(v) => pick(exp, v)} />}
    </div>
  );
}

function NameField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="ins-name"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label="Analysis name"
      data-no-draft
    />
  );
}

// ─── Board ────────────────────────────────────────────────────────────────

function Board(p: {
  a: Analysis;
  results: Record<string, Result>;
  filters: Filter[];
  busy: boolean;
  onPick: (w: Widget, v: string) => void;
  onExpand: (id: string) => void;
  setBoard: (b: Widget[]) => void;
  onAsk: (t: string) => void;
  onFiles: (f: File[]) => void;
  uploading: boolean;
}) {
  const { a } = p;
  const [drag, setDrag] = useState<string | null>(null);
  if (!a.sources.length)
    return (
      <div className="ins-empty">
        <DropZone big onFiles={p.onFiles} busy={p.uploading} />
      </div>
    );
  if (!a.board.length)
    return (
      <div className="ins-empty">
        {p.busy ? (
          <div className="ins-building">
            <div className="ins-pulse">
              <Sparkles size={22} />
            </div>
            <b>The analyst is reading your data and building the board…</b>
            <span className="ins-muted">Charts appear here as they&apos;re made.</span>
          </div>
        ) : (
          <div className="ins-building">
            <BarChart3 size={26} className="ins-muted" />
            <b>No charts yet</b>
            <button className="ix-btn primary" onClick={() => p.onAsk("Analyse this data and build the first board.")}>
              <Sparkles size={14} /> Analyse my data
            </button>
          </div>
        )}
      </div>
    );
  const move = (from: string, to: string) => {
    if (from === to) return;
    const b = [...a.board];
    const i = b.findIndex((w) => w.id === from);
    const [w] = b.splice(i, 1);
    b.splice(
      b.findIndex((x) => x.id === to),
      0,
      w,
    );
    p.setBoard(b);
  };
  return (
    <div className="ins-grid">
      {a.board.map((w) => (
        <div
          key={w.id}
          className={`ins-cell${drag === w.id ? " dragging" : ""}`}
          style={{ gridColumn: `span ${Math.min(12, Math.max(2, w.size ?? 6))}` }}
          onDragOver={(e) => drag && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (drag) move(drag, w.id);
            setDrag(null);
          }}
        >
          <Card
            w={w}
            r={p.results[w.id]}
            filtered={p.filters.length > 0}
            onPick={(v) => p.onPick(w, v)}
            onExpand={() => p.onExpand(w.id)}
            onResize={(size) => p.setBoard(a.board.map((x) => (x.id === w.id ? { ...x, size } : x)))}
            onRemove={() => p.setBoard(a.board.filter((x) => x.id !== w.id))}
            onAsk={(t) => p.onAsk(t)}
            dragHandle={{ draggable: true, onDragStart: () => setDrag(w.id), onDragEnd: () => setDrag(null) }}
          />
        </div>
      ))}
    </div>
  );
}

function Card({
  w, r, filtered, onPick, onExpand, onResize, onRemove, onAsk, dragHandle,
}: {
  w: Widget;
  r?: Result;
  filtered: boolean;
  onPick: (v: string) => void;
  onExpand: () => void;
  onResize: (n: number) => void;
  onRemove: () => void;
  onAsk: (t: string) => void;
  dragHandle: React.HTMLAttributes<HTMLSpanElement> & { draggable: boolean };
}) {
  const [menu, setMenu] = useState(false);
  const chart = useRef<ECharts | null>(null);
  const data = r && !("error" in r) ? r : null;
  const err = r && "error" in r ? r.error : null;
  const head = (
    <div className="ins-card-head">
      <span className="ins-grip" title="Drag to move" {...dragHandle}>
        <GripVertical size={14} />
      </span>
      <div className="ins-card-titles">
        <h3>{w.title}</h3>
        {w.subtitle && <p>{w.subtitle}</p>}
      </div>
      <div className="ins-card-tools">
        {w.kind !== "insight" && w.kind !== "kpi" && w.kind !== "whatif" && (
          <button onClick={onExpand} title="Expand">
            <Maximize2 size={14} />
          </button>
        )}
        <button onClick={() => setMenu(!menu)} title="More">
          <MoreHorizontal size={15} />
        </button>
        {menu && (
          <div className="ins-menu" onMouseLeave={() => setMenu(false)}>
            <div className="ins-menu-sizes">
              Width
              {[3, 4, 6, 8, 12].map((n) => (
                <button key={n} className={(w.size ?? 6) === n ? "on" : ""} onClick={() => onResize(n)}>
                  {n === 12 ? "Full" : `${n}/12`}
                </button>
              ))}
            </div>
            <button onClick={() => (setMenu(false), onAsk(`Explain "${w.title}" in more depth: what's driving it and what should I do about it?`))}>
              <Lightbulb size={14} /> Explain this
            </button>
            <button onClick={() => (setMenu(false), onAsk(`Improve the chart "${w.title}" [${w.id}]: is there a better way to show this?`))}>
              <Sparkles size={14} /> Improve this chart
            </button>
            {data && (
              <button onClick={() => (setMenu(false), downloadCsv(w.title, data))}>
                <Download size={14} /> Download data (CSV)
              </button>
            )}
            {chart.current && (
              <button
                onClick={() => {
                  setMenu(false);
                  const url = chart.current!.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--ix-panel") || "#fff" });
                  const l = document.createElement("a");
                  l.href = url;
                  l.download = `${w.title}.png`;
                  l.click();
                }}
              >
                <Download size={14} /> Download image
              </button>
            )}
            <button className="danger" onClick={() => (setMenu(false), onRemove())}>
              <Trash2 size={14} /> Remove
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (w.kind === "insight") {
    const v = data?.rows[0]?.[data.columns.findIndex((c) => c.name === w.y?.[0])];
    return (
      <div className={`ins-card-box ins-insight tone-${w.tone ?? "neutral"}`}>
        {head}
        <div className="ins-insight-body">
          <div className="ins-insight-icon">{w.tone === "bad" ? <TrendingDown size={18} /> : w.tone === "good" ? <TrendingUp size={18} /> : w.tone === "watch" ? <Eye size={18} /> : <Lightbulb size={18} />}</div>
          <div>
            {v !== undefined && <div className="ins-insight-value">{fmt(v, w, true)}</div>}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{w.insight ?? ""}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  if (w.kind === "kpi") {
    const yi = data ? data.columns.findIndex((c) => c.name === w.y?.[0]) : -1;
    const ci = data ? data.columns.findIndex((c) => c.name === w.y?.[1]) : -1;
    const v = data && yi >= 0 ? Number(data.rows[0]?.[yi]) : null;
    const prev = data && ci >= 0 ? Number(data.rows[0]?.[ci]) : null;
    const change = v !== null && prev ? (v - prev) / Math.abs(prev) : null;
    const goodUp = w.tone !== "bad";
    return (
      <div className="ins-card-box ins-kpi">
        {head}
        {err ? (
          <div className="ins-err">{err}</div>
        ) : (
          <>
            <div className="ins-kpi-value">{v === null ? <span className="ins-skel" /> : fmt(v, w, Math.abs(v) < 1e6)}</div>
            {change !== null && Number.isFinite(change) && (
              <div className={`ins-kpi-change ${change >= 0 === goodUp ? "up" : "down"}`}>
                {change >= 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />} {Math.abs(change * 100).toFixed(1)}%<span className="ins-muted"> vs {fmt(prev, w)}</span>
              </div>
            )}
            {w.insight && <p className="ins-kpi-note">{w.insight}</p>}
          </>
        )}
      </div>
    );
  }

  const h = chartHeight(w, data);
  return (
    <div className="ins-card-box">
      {head}
      {err ? (
        <div className="ins-err">
          <AlertTriangle size={14} /> {err}
        </div>
      ) : !data ? (
        <div className="ins-skel-chart" style={{ height: h }} />
      ) : !data.rows.length ? (
        <div className="ins-nodata" style={{ height: Math.min(h, 160) }}>
          {filtered ? "Nothing matches the filters" : "No data"}
        </div>
      ) : w.kind === "table" ? (
        <MiniTable w={w} d={data} />
      ) : w.kind === "whatif" ? (
        <WhatIf w={w} model={(data.meta as { model?: DriverModel } | undefined)?.model} />
      ) : (
        <Chart w={w} data={data} height={h} onPick={MODEL_KINDS.has(w.kind) && !["network", "anomalies"].includes(w.kind) ? undefined : onPick} chartRef={(c) => (chart.current = c)} />
      )}
      {data && <ModelNote w={w} data={data} />}
      {w.insight && (
        <div className="ins-why">
          <Lightbulb size={13} />
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{w.insight}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

const MODEL_KINDS = new Set(["forecast", "drivers", "whatif", "correlation", "network", "process", "anomalies"]);

type DriverModel = {
  target: string;
  binary: boolean;
  n: number;
  r2: number;
  intercept: number;
  targetMean: number;
  coef: Record<string, number | Record<string, number>>;
  factors: { name: string; kind: "number" | "category"; importance: number; mean?: number; sd?: number; min?: number; max?: number; baseline?: string; levels?: { value: string; effect: number; count: number; mean: number }[] }[];
  interactions: { factors: [string, string]; values: [string, string]; extra: number; count: number; mean: number }[];
};

/** How a model item was made and how far to trust it, in one line (and combinations for drivers). */
function ModelNote({ w, data }: { w: Widget; data: Data & { meta?: Record<string, unknown> } }) {
  const m = data.meta;
  if (!m) return null;
  if (w.kind === "forecast") {
    const { method, mape, note } = m as { method: string; mape: number | null; note?: string };
    return (
      <div className="ins-model">
        <Sparkles size={12} /> {method}
        {mape !== null && mape !== undefined && (
          <span className={`ins-acc ${mape < 0.1 ? "good" : mape < 0.25 ? "ok" : "poor"}`}>
            {mape < 0.1 ? "High" : mape < 0.25 ? "Fair" : "Low"} accuracy: {(mape * 100).toFixed(1)}% average error on recent history it didn&apos;t see
          </span>
        )}
        {note && <span className="ins-muted"> · {note}</span>}
      </div>
    );
  }
  if (w.kind === "drivers" || w.kind === "whatif") {
    const model = (m as { model?: DriverModel }).model;
    if (!model) return null;
    const pct = (v: number) => (model.binary ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)} pts` : `${v >= 0 ? "+" : ""}${fmt(v, w)}`);
    return (
      <div className="ins-model col">
        <div>
          <Sparkles size={12} /> These factors explain <b>{(model.r2 * 100).toFixed(0)}%</b> of the variation in {model.target} across {model.n.toLocaleString()} rows.
          <span className="ins-muted"> Associations, not proof of cause.</span>
        </div>
        {w.kind === "drivers" && model.interactions.length > 0 && (
          <div className="ins-combos">
            <b>Combinations that matter more than their parts</b>
            {model.interactions.slice(0, 4).map((x, i) => (
              <span key={i} className={`ins-combo ${x.extra > 0 === !model.binary ? "up" : "down"}`}>
                {x.values[0]} × {x.values[1]}: <b>{pct(x.extra)}</b> extra · avg {model.binary ? `${(x.mean * 100).toFixed(0)}%` : fmt(x.mean, w)} · {x.count} rows
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (w.kind === "network") {
    const meta = m as { clusters?: number; edges?: unknown[] };
    const top = [...data.rows].sort((a, b) => Number(b[4]) - Number(a[4])).slice(0, 3).filter((r) => Number(r[4]) > 0);
    return (
      <div className="ins-model col">
        <div>
          <Network size={12} /> {data.rows.length} nodes · {meta.edges?.length ?? 0} links · <b>{meta.clusters ?? 1}</b> cluster{meta.clusters === 1 ? "" : "s"}. Drag to rearrange, scroll to zoom, hover a node to light up its connections.
        </div>
        {top.length > 0 && (
          <div className="ins-combos">
            <b>Key connectors (outlined): on the most paths between others</b>
            {top.map((r) => (
              <span key={String(r[0])} className="ins-combo up">
                {String(r[0])}: {String(r[3])} connections, cluster {String(r[5])}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (w.kind === "process") {
    const pm = (m as { process?: { cases: number; avgCase: number; medianCase: number; unit: string; variants: { path: string[]; cases: number }[] } }).process;
    if (!pm) return null;
    const worst = data.rows[0];
    return (
      <div className="ins-model col">
        <div>
          <Sparkles size={12} /> {pm.cases.toLocaleString()} cases · average {pm.avgCase} {pm.unit} end to end (median {pm.medianCase}). Line thickness = cases, colour = wait: <span style={{ color: "#10b981" }}>quick</span>, <span style={{ color: "#f59e0b" }}>slower</span>,{" "}
          <span style={{ color: "#ef4444" }}>slowest</span>.
        </div>
        {worst && (
          <div className="ins-combos">
            <b>Biggest bottleneck</b>
            <span className="ins-combo up">
              {String(worst[0])} → {String(worst[1])}: {fmt(worst[3])} {pm.unit} average wait over {String(worst[2])} cases ({fmt(worst[5])} {pm.unit} in total)
            </span>
            {pm.variants[0] && (
              <span className="ins-combo down">
                Most common path ({pm.variants[0].cases} cases): {pm.variants[0].path.join(" → ")}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
  if (w.kind === "anomalies") {
    const n = Number((m as { count?: number }).count ?? 0);
    return (
      <div className="ins-model">
        <AlertTriangle size={12} /> <b>{n}</b> unusual value{n === 1 ? "" : "s"} out of {data.rows.length}, judged against {(m as { grouped?: boolean }).grouped ? "each group's" : "the"} typical range (robust to the outliers themselves).
      </div>
    );
  }
  if (w.kind === "correlation") return <div className="ins-model"><Sparkles size={12} /> {(m as { method?: string }).method === "spearman" ? "Spearman (rank) correlation" : "Pearson correlation"}: 1 moves together, −1 moves opposite, 0 no link. Hover a cell for details.</div>;
  return null;
}

/** A live calculator from a drivers model: move each factor, see the predicted target. */
function WhatIf({ w, model }: { w: Widget; model?: DriverModel }) {
  const start = useMemo(() => {
    const s: Record<string, number | string> = {};
    for (const f of model?.factors ?? []) {
      if (f.kind === "number") s[f.name] = +(f.mean ?? 0).toFixed(2);
      else s[f.name] = [...(f.levels ?? [])].sort((a, b) => b.count - a.count)[0]?.value ?? f.baseline ?? "";
    }
    return s;
  }, [model]);
  const [vals, setVals] = useState(start);
  useEffect(() => setVals(start), [start]);
  if (!model) return <div className="ins-nodata">The model couldn&apos;t be built from this data.</div>;
  const predict = (v: Record<string, number | string>) => {
    let y = model.intercept;
    for (const [k, c] of Object.entries(model.coef)) {
      if (typeof c === "number") y += c * Number(v[k] ?? 0);
      else y += c[String(v[k])] ?? 0;
    }
    return model.binary ? Math.min(1, Math.max(0, y)) : y;
  };
  const base = predict(start);
  const now = predict(vals);
  const show = (v: number) => (model.binary ? `${(v * 100).toFixed(1)}%` : fmt(v, w, true));
  const delta = now - base;
  const factors = model.factors.filter((f) => f.importance > 0.01).slice(0, 8);
  return (
    <div className="ins-whatif">
      <div className="ins-whatif-result">
        <span className="ins-muted">Predicted {model.target}</span>
        <b>{show(now)}</b>
        {Math.abs(delta) > 1e-9 && (
          <span className={delta > 0 ? "up" : "down"}>
            {delta > 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />} {model.binary ? `${(Math.abs(delta) * 100).toFixed(1)} pts` : fmt(Math.abs(delta), w, true)} vs typical {show(base)}
          </span>
        )}
        <button className="ins-link" onClick={() => setVals(start)}>
          Reset
        </button>
      </div>
      <div className="ins-whatif-controls">
        {factors.map((f) => (
          <label key={f.name} className="ins-whatif-row">
            <span>
              {f.name} <small className="ins-muted">{(f.importance * 100).toFixed(0)}%</small>
            </span>
            {f.kind === "number" ? (
              <>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  step={((f.max ?? 1) - (f.min ?? 0)) / 100 || 1}
                  value={Number(vals[f.name])}
                  onChange={(e) => setVals({ ...vals, [f.name]: Number(e.target.value) })}
                />
                <output>{fmt(Number(vals[f.name]), undefined, true)}</output>
              </>
            ) : (
              <select value={String(vals[f.name])} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>
                {(f.levels ?? []).map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.value}
                  </option>
                ))}
              </select>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

function MiniTable({ w, d }: { w: Widget; d: Data }) {
  const numCols = d.columns.map((c) => isNumType(c.type) && !isIdName(c.name));
  return (
    <div className="ins-table-wrap" style={{ maxHeight: 420 }}>
      <table className="ins-table">
        <thead>
          <tr>
            {d.columns.map((c, i) => (
              <th key={c.name} className={numCols[i] ? "num" : ""}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.rows.slice(0, 300).map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className={numCols[j] ? "num" : ""}>
                  {numCols[j] ? fmt(v, (w.y ?? []).includes(d.columns[j].name) ? w : undefined, true) : label(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function downloadCsv(title: string, d: Data) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [d.columns.map((c) => esc(c.name)).join(","), ...d.rows.map((r) => r.map(esc).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  const l = document.createElement("a");
  l.href = url;
  l.download = `${title}.csv`;
  l.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Expanded({ w, r, onClose, onPick }: { w: Widget; r?: Result; onClose: () => void; onPick: (v: string) => void }) {
  const [view, setView] = useState<"chart" | "data" | "sql">("chart");
  const data = r && !("error" in r) ? r : null;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="ins-modal" onClick={onClose}>
      <div className="ins-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="ins-modal-head">
          <div>
            <h2>{w.title}</h2>
            {w.subtitle && <p className="ins-muted">{w.subtitle}</p>}
          </div>
          <nav className="ins-tabs">
            {(["chart", "data", "sql"] as const).map((v) => (
              <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {v === "chart" ? "Chart" : v === "data" ? "Data" : "How it's calculated"}
              </button>
            ))}
          </nav>
          <button className="ins-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="ins-modal-body">
          {view === "chart" && data && (w.kind === "table" ? <MiniTable w={w} d={data} /> : <Chart w={w} data={data} height={Math.max(420, window.innerHeight - 300)} onPick={onPick} />)}
          {view === "data" && data && <MiniTable w={{ ...w, kind: "table" }} d={data} />}
          {view === "sql" && (
            <div className="ins-sql">
              <p className="ins-muted">This chart is this query over your data, re-run live whenever you filter the board.</p>
              <pre>{w.sql ?? "(no query)"}</pre>
            </div>
          )}
          {w.insight && (
            <div className="ins-why big">
              <Lightbulb size={15} />
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{w.insight}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Data and files ──────────────────────────────────────────────────────────

function DataView({ a, filters }: { a: Analysis; filters: Filter[] }) {
  const [table, setTable] = useState(a.tables[0]?.name ?? "");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [d, setD] = useState<{ columns: Col[]; rows: unknown[][]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = a.tables.find((x) => x.name === table);
  useEffect(() => {
    if (!table && a.tables[0]) setTable(a.tables[0].name);
  }, [a.tables, table]);
  useEffect(() => {
    if (!table) return;
    const h = setTimeout(() => {
      api<{ columns: Col[]; rows: unknown[][]; total: number }>(`/api/insights/${a.id}/data`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ table, offset: page * 100, limit: 100, sort: sort?.col, desc: sort?.desc, search, filters }),
      })
        .then((r) => (setD(r), setErr(null)))
        .catch((e) => setErr(e.message));
    }, 200);
    return () => clearTimeout(h);
  }, [a.id, table, page, sort, search, filters]);
  if (!a.tables.length)
    return (
      <div className="ins-empty">
        <div className="ins-building">
          <Database size={24} className="ins-muted" />
          <b>No tables yet</b>
          <span className="ins-muted">Spreadsheets, CSVs and tables inside documents show up here.</span>
        </div>
      </div>
    );
  return (
    <div className="ins-data">
      <aside className="ins-data-list">
        {a.tables.map((x) => (
          <button key={x.name} className={x.name === table ? "on" : ""} onClick={() => (setTable(x.name), setPage(0), setSort(null))}>
            <FileSpreadsheet size={14} />
            <span>
              <b>{x.name}</b>
              <small>
                {x.rows.toLocaleString()} rows · {x.columns.length} cols{x.derived ? " · made by AI" : ""}
              </small>
            </span>
          </button>
        ))}
      </aside>
      <div className="ins-data-main">
        <div className="ins-data-bar">
          <div>
            <b>{t?.name}</b>
            <span className="ins-muted ins-small">
              {" "}
              from {t?.source}
              {t?.part ? `, ${t.part}` : ""}
              {t?.title ? ` · ${t.title}` : ""}
            </span>
          </div>
          <label className="ins-search">
            <Search size={13} />
            <input value={search} onChange={(e) => (setSearch(e.target.value), setPage(0))} placeholder="Search rows" data-no-draft />
          </label>
        </div>
        {err && <div className="ins-err">{err}</div>}
        <div className="ins-table-wrap grow">
          <table className="ins-table">
            <thead>
              <tr>
                <th className="rownum">#</th>
                {(d?.columns ?? t?.columns ?? []).map((c) => (
                  <th key={c.name} className={isNumType(c.type) ? "num" : ""} onClick={() => setSort(sort?.col === c.name ? { col: c.name, desc: !sort.desc } : { col: c.name, desc: false })}>
                    <span className="ins-th">
                      {c.name}
                      {sort?.col === c.name && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                    </span>
                    <small>{c.type.toLowerCase().replace(/\(.*\)/, "")}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d?.rows.map((r, i) => (
                <tr key={i}>
                  <td className="rownum">{page * 100 + i + 1}</td>
                  {r.map((v, j) => (
                    <td key={j} className={isNumType(d.columns[j].type) ? "num" : ""}>
                      {v === null ? <span className="ins-null">–</span> : isNumType(d.columns[j].type) && !isIdName(d.columns[j].name) ? fmt(v, undefined, true) : label(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {d && (
          <div className="ins-pager">
            <span className="ins-muted">
              {d.total ? `${page * 100 + 1}–${Math.min(d.total, page * 100 + 100)} of ${d.total.toLocaleString()}` : "No rows"}
              {filters.length ? " (filtered)" : ""}
            </span>
            <button className="ix-btn" disabled={!page} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button className="ix-btn" disabled={(page + 1) * 100 >= d.total} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FilesView({ a, onRemove, onFiles, uploading }: { a: Analysis; onRemove: (id: string) => Promise<void>; onFiles: (f: File[]) => void; uploading: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="ins-files">
      <DropZone onFiles={onFiles} busy={uploading} />
      {a.sources.map((s) => (
        <div key={s.id} className="ins-file">
          <div className="ins-file-icon">{s.kind === "spreadsheet" || s.kind === "csv" ? <FileSpreadsheet size={18} /> : <FileText size={18} />}</div>
          <div className="ins-file-main">
            <b>{s.name}</b>
            <span className="ins-muted ins-small">
              {bytes(s.size)} · {s.kind}
              {s.tables.length ? ` · ${s.tables.length} table${s.tables.length > 1 ? "s" : ""}: ${s.tables.join(", ")}` : ""}
              {s.textChars ? ` · ${s.textChars.toLocaleString()} characters of text` : ""}
            </span>
            {s.note && <span className="ins-small ins-warn">{s.note}</span>}
          </div>
          <button
            className="ins-icon-btn"
            title="Remove this file and its tables"
            disabled={busy === s.id}
            onClick={async () => {
              if (!confirm(`Remove ${s.name} and its tables? Charts built on them will stop working.`)) return;
              setBusy(s.id);
              await onRemove(s.id).finally(() => setBusy(null));
            }}
          >
            {busy === s.id ? <Loader2 size={15} className="ins-spin" /> : <Trash2 size={15} />}
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── The analyst ──────────────────────────────────────────────────────────────

function ChatPanel({ a, live, questions, onSend, onClose }: { a: Analysis; live: Live | null; questions: string[]; onSend: (t: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [a.chat.length, live?.text, live?.steps.length]);
  const go = () => {
    if (!text.trim() || live?.busy) return;
    onSend(text.trim());
    setText("");
  };
  const starters = useMemo(
    () => ["What are the 3 most important things in this data?", "Where are the bottlenecks or problems?", "What's changing over time, and why?", "Which factors drive the main numbers?"],
    [],
  );
  return (
    <aside className="ins-chat">
      <div className="ins-chat-head">
        <div className="ins-chat-title">
          <div className="ins-pulse small">
            <Sparkles size={13} />
          </div>
          <b>Analyst</b>
        </div>
        <button className="ins-icon-btn" onClick={onClose} title="Hide">
          <X size={16} />
        </button>
      </div>
      <div className="ins-chat-body">
        {!a.chat.length && !live && (
          <div className="ins-chat-empty">
            <MessageSquare size={20} className="ins-muted" />
            <p>Ask anything about your data. The analyst checks every number against the data and adds charts to the board as it goes.</p>
            {a.sources.length > 0 && starters.map((s) => (
              <button key={s} className="ins-suggest" onClick={() => onSend(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {a.chat.map((m, i) => (
          <div key={i} className={`ins-msg ${m.role}`}>
            {m.role === "assistant" && m.steps && m.steps.length > 0 && <Steps steps={m.steps} />}
            <div className="ins-msg-text">
              {m.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown> : m.text}
            </div>
          </div>
        ))}
        {live && (
          <div className="ins-msg assistant">
            <Steps steps={live.steps} live />
            {live.text ? (
              <div className="ins-msg-text">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{live.text}</ReactMarkdown>
              </div>
            ) : (
              <div className="ins-thinking">
                <Loader2 size={13} className="ins-spin" /> {live.thought ? <span>{live.thought.split("\n").filter(Boolean).pop()?.slice(0, 140)}</span> : "Thinking…"}
              </div>
            )}
          </div>
        )}
        {!live && questions.length > 0 && (
          <div className="ins-questions">
            {questions.map((q) => (
              <button key={q} className="ins-suggest" onClick={() => onSend(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="ins-chat-input">
        <textarea
          ref={box}
          value={text}
          rows={2}
          placeholder={live?.busy ? "The analyst is working…" : "Ask about your data, or ask for a chart…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              go();
            }
          }}
        />
        <button className="ins-send" disabled={!text.trim() || !!live?.busy} onClick={go} aria-label="Send">
          {live?.busy ? <Loader2 size={16} className="ins-spin" /> : <Send size={16} />}
        </button>
      </div>
    </aside>
  );
}

function Steps({ steps, live }: { steps: string[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const shown = open ? steps : steps.slice(-3);
  return (
    <div className="ins-steps">
      {steps.length > 3 && (
        <button className="ins-link" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `${steps.length} steps`}
        </button>
      )}
      {shown.map((s, i) => (
        <div key={i} className="ins-step">
          {live && i === shown.length - 1 ? <Loader2 size={11} className="ins-spin" /> : <span className="ins-dot" />} {s}
        </div>
      ))}
    </div>
  );
}
