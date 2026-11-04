"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Captions, CheckSquare, Download, Languages, Link2, Lock, Mail, MessageSquare, Pencil, Play, RefreshCw, Search, Send, Share2, Sparkles, Trash2, Video } from "lucide-react";
import { colorFor, meetApi } from "./api";
import { BoardView, downloadBoard, type BoardItem } from "./Board";
import "./report.css";

/**
 * The meeting report (Read-style): scores, summary, chapters, action items,
 * key questions, decisions, template sections, highlights and clips, speaker
 * cards, a sentiment and engagement timeline, the transcript with speakers,
 * and "Ask this meeting". Everything with a time seeks the player.
 */

type Report = {
  version: 2;
  template: string;
  language: string;
  summary: string;
  chapters: { title: string; start: number; end: number; summary: string }[];
  actionItems: { title: string; owner: string; due: string; start: number | null }[];
  keyQuestions: { question: string; askedBy: string; answered: boolean; start: number | null }[];
  decisions: string[];
  topics: string[];
  highlights: { start: number; end: number; text: string; by: string }[];
  sections: { title: string; body: string }[];
  scores: { read: number; sentiment: number; engagement: number };
  timeline: { start: number; sentiment: number; engagement: number }[];
};
type Speaker = { name: string; talkSec: number; words: number; wpm: number; fillers: number; questions: number; nonInclusive: number; longestMonologueSec: number; joinedLateSec: number | null };
type Segment = { seq: number; start: number; end: number; speaker: string; text: string };
type Media = { id: string; kind: "video" | "audio"; offset: number; file: string };
type ReportReply = {
  title: string;
  code: string;
  host: boolean;
  status: string;
  error: string;
  at: string | null;
  startedAt: string;
  taskIds: string[];
  postedAt: string | null;
  sentAt: string | null;
  channelId: string | null;
  kind: string;
  template: string;
  reportLang: string;
  durationSec: number | null;
  building: boolean;
  report: Report | null;
  languages: string[];
  templates: { id: string; name: string; builtin: boolean }[];
  speakers: Speaker[];
  segments: Segment[];
  media: Media[];
};
type Rec = { id: string; kind: string; status: string; size: number; startedAt: string; file: string; error: string };
type Line = { id: string; name: string; text: string; at: string };
type Chat = { id: string; fromName: string; toName: string | null; text: string; files: { id: string; name: string; size: number }[]; at: string };
type Ask = { q: string; answer?: string; citations?: number[]; error?: string };

const STATUS: Record<string, string> = {
  "": "No AI notes were taken in this meeting.",
  recording: "Recording. The report will be written when the recording stops or the meeting ends.",
  processing: "Writing the report: transcribing with speakers and times, then summarizing…",
  failed: "The report couldn't be written.",
};
const LANGS = ["English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch", "Hindi", "Bengali", "Tamil", "Japanese", "Chinese", "Korean", "Arabic", "Russian", "Turkish", "Polish", "Indonesian"];
const KIND: Record<string, string> = { upload: "Uploaded recording", inperson: "In-person", external: "Captured call", webinar: "Webinar", meeting: "Meet call" };

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};
const mins = (sec: number) => (sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);
const tone = (v: number) => (v >= 70 ? "var(--ws-ok, #16a34a)" : v >= 45 ? "#d97706" : "var(--ws-danger, #dc2626)");

function Score({ label, value, hint }: { label: string; value: number; hint: string }) {
  const r = 20, c = 2 * Math.PI * r;
  return (
    <div className="mt-score" title={hint}>
      <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden>
        <circle cx="24" cy="24" r={r} fill="none" stroke="var(--ix-line)" strokeWidth="5" />
        <circle cx="24" cy="24" r={r} fill="none" stroke={tone(value)} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(c * value) / 100} ${c}`} transform="rotate(-90 24 24)" />
      </svg>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
    </div>
  );
}

/** Sentiment and engagement over the meeting; click to jump there. */
function Timeline({ points, duration, now, onSeek }: { points: Report["timeline"]; duration: number; now: number; onSeek: (t: number) => void }) {
  const W = 600, H = 120, pad = 6;
  const x = (t: number) => pad + (Math.min(t, duration) / Math.max(duration, 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - (v / 100) * (H - 2 * pad);
  const path = (k: "sentiment" | "engagement") => points.map((p, i) => `${i ? "L" : "M"}${x(p.start).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  if (!points.length) return null;
  return (
    <div>
      <svg
        className="mt-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Sentiment and engagement over the meeting"
        onClick={(e) => {
          const b = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          onSeek(((e.clientX - b.left) / b.width) * duration);
        }}
      >
        {[25, 50, 75].map((v) => <line key={v} x1={pad} x2={W - pad} y1={y(v)} y2={y(v)} stroke="var(--ix-line)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
        <path d={path("engagement")} fill="none" stroke="var(--accent, #6366f1)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <path d={path("sentiment")} fill="none" stroke="#10b981" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        {now > 0 && <line x1={x(now)} x2={x(now)} y1={0} y2={H} stroke="var(--ix-ink)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mt-legend">
        <span><i style={{ background: "#10b981" }} /> Sentiment</span>
        <span><i style={{ background: "var(--accent, #6366f1)" }} /> Engagement</span>
        <span className="mt-note">0:00 – {clock(duration)} · click to jump</span>
      </div>
    </div>
  );
}

/** "[t=123]" citations in an answer become buttons that seek the player. */
function Cited({ text, onSeek }: { text: string; onSeek: (t: number) => void }) {
  const parts = text.split(/(\[t=\d+(?:\.\d+)?\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[t=(\d+(?:\.\d+)?)\]$/.exec(p);
        return m ? <button key={i} className="mt-ts" onClick={() => onSeek(Number(m[1]))}>{clock(Number(m[1]))}</button> : <span key={i}>{p}</span>;
      })}
    </>
  );
}

const Body = ({ text }: { text: string }) => {
  const lines = text.split(/\n+/).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => /^\s*[-•*]\s+/.test(l))) return <ul>{lines.map((l, i) => <li key={i}>{l.replace(/^\s*[-•*]\s+/, "")}</li>)}</ul>;
  return <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{text}</p>;
};

export default function NotesView({ code, canTasks, canChat }: { code: string; canTasks: boolean; canChat: boolean }) {
  const [d, setD] = useState<ReportReply | null>(null);
  const [err, setErr] = useState("");
  const [lang, setLang] = useState("");
  const [recs, setRecs] = useState<Rec[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [channels, setChannels] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [chat, setChat] = useState<Chat[]>([]);
  const [board, setBoard] = useState<BoardItem[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [clipEnd, setClipEnd] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [asks, setAsks] = useState<Ask[]>([]);
  const [question, setQuestion] = useState("");
  const [shareTo, setShareTo] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [rename, setRename] = useState<{ from: string; to: string } | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const scriptRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await meetApi<ReportReply>(`/${code}/report${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`);
      setD(r);
      if (r.report) setPicked((p) => (p.size ? p : new Set(r.report!.actionItems.map((_, i) => i))));
      meetApi<{ recordings: Rec[] }>(`/${code}/recordings`).then((x) => setRecs(x.recordings)).catch(() => {});
      if (r.kind === "meeting" || r.kind === "webinar") {
        meetApi<{ lines: Line[] }>(`/${code}/transcript`).then((x) => setLines(x.lines)).catch(() => {});
        meetApi<{ messages: Chat[] }>(`/${code}/chat`).then((x) => setChat(x.messages)).catch(() => {});
        meetApi<{ strokes: BoardItem[] }>(`/${code}/board`).then((x) => setBoard(x.strokes)).catch(() => {});
      }
    } catch (e) {
      setErr((e as Error).message === "Not found" ? "You don't have access to this meeting's report." : (e as Error).message);
    }
  }, [code, lang]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!d || !(["processing", "recording"].includes(d.status) || d.building)) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [d, load]);
  useEffect(() => {
    if (!d?.host) return;
    if (canTasks) fetch("/workspace/api/tasks/projects").then((r) => r.json()).then((x) => setProjects(x.projects ?? [])).catch(() => {});
    if (canChat && !d.channelId) fetch("/workspace/api/chat/channels").then((r) => r.json()).then((x) => setChannels((x.channels ?? []).filter((c: { joined: boolean }) => c.joined))).catch(() => {});
  }, [d?.host, d?.channelId, canTasks, canChat]);

  const media = useMemo(() => d?.media.find((m) => m.id === mediaId) ?? d?.media[0] ?? null, [d?.media, mediaId]);
  const off = media?.offset ?? 0;
  const duration = useMemo(() => Math.max(d?.durationSec ?? 0, ...(d?.segments.map((s) => s.end) ?? [0]), 1), [d?.durationSec, d?.segments]);

  /** Jump to a moment (seconds on the transcript's clock); with end, play just that clip. */
  const seek = useCallback(
    (t: number, end?: number) => {
      setNow(t);
      setClipEnd(end ?? null);
      const el = mediaRef.current;
      if (el) {
        el.currentTime = Math.max(0, t - off);
        el.play().catch(() => {});
      }
      const box = scriptRef.current;
      const seg = d?.segments.find((s) => s.end >= t) ?? null;
      const row = seg && box?.querySelector<HTMLElement>(`[data-seq="${seg.seq}"]`);
      if (box && row) box.scrollTop = row.offsetTop - box.offsetTop - 48;
    },
    [off, d?.segments],
  );

  // Links from Ask, For You, Coaching and the Daily Read carry ?t=<seconds>: jump there once the report is in.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !d?.segments.length) return;
    jumped.current = true;
    const t = Number(new URLSearchParams(window.location.search).get("t"));
    if (Number.isFinite(t) && t > 0) setTimeout(() => seek(t), 300);
  }, [d?.segments.length, seek]);

  const act = async (label: string, path: string, body: Record<string, unknown>, done: (r: any) => string) => {
    setBusy(label);
    setMsg("");
    try {
      const r = await meetApi(`/${code}/${path}`, { body });
      setMsg(done(r));
      await load();
      return r;
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const translate = async (l: string) => {
    if (!d?.report) return;
    if (!l || l.toLowerCase() === d.report.language.toLowerCase()) return setLang("");
    setBusy("lang");
    setMsg("");
    try {
      await meetApi(`/${code}/report`, { body: { action: "translate", lang: l } });
      setLang(l);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    setAsks((a) => [...a, { q: text }]);
    try {
      const r = await meetApi<{ answer: string; citations: number[] }>(`/${code}/ask`, { body: { question: text } });
      setAsks((a) => a.map((x, i) => (i === a.length - 1 ? { ...x, answer: r.answer, citations: r.citations } : x)));
    } catch (e2) {
      setAsks((a) => a.map((x, i) => (i === a.length - 1 ? { ...x, error: (e2 as Error).message } : x)));
    }
  };

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? (d?.segments ?? []).filter((x) => x.text.toLowerCase().includes(s) || x.speaker.toLowerCase().includes(s)) : (d?.segments ?? []);
  }, [q, d?.segments]);

  if (err)
    return (
      <div className="mt-notes">
        <p className="mt-error">{err}</p>
      </div>
    );
  if (!d)
    return (
      <div className="mt-notes">
        <p className="mt-note">Loading…</p>
      </div>
    );
  const r = d.report;
  const totalTalk = d.speakers.reduce((a, s) => a + s.talkSec, 0) || 1;
  const working = d.status === "processing" || d.building;
  const hl = (text: string) => {
    const s = q.trim();
    if (!s) return text;
    const i = text.toLowerCase().indexOf(s.toLowerCase());
    return i < 0 ? text : (<>{text.slice(0, i)}<mark>{text.slice(i, i + s.length)}</mark>{text.slice(i + s.length)}</>);
  };

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div className="mt-notes mt-report">
        <header className="mt-rhead">
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="mt-note" style={{ margin: 0 }}>
              {KIND[d.kind] ?? "Meeting"} · {new Date(d.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              {d.durationSec ? ` · ${mins(d.durationSec)}` : ""}
              {(d.kind === "meeting" || d.kind === "webinar") && <> · <a href={`/workspace/meet/${d.code}`}>{d.code}</a></>}
            </p>
            <h1 className="mt-rtitle">{d.title}</h1>
            {r && r.topics.length > 0 && <div className="mt-chips">{r.topics.map((t) => <span key={t} className="mt-pill">{t}</span>)}</div>}
          </div>
          {r && (
            <div className="mt-scores">
              <Score label="Read score" value={r.scores.read} hint="Sentiment and engagement, plus structure (agenda, decisions, action items) and starting on time. From speech and text only." />
              <Score label="Sentiment" value={r.scores.sentiment} hint="How positive the language was." />
              <Score label="Engagement" value={r.scores.engagement} hint="Turn-taking, how evenly people spoke, questions and interruptions." />
            </div>
          )}
        </header>

        <div className="mt-actions mt-rtools">
          {d.templates.length > 0 && (
            <select className="mt-select" aria-label="Report template" value={d.template} disabled={!d.host || working || !!busy} title={d.host ? "Report template" : "Only the host can change the template"}
              onChange={(e) => act("tpl", "report", { action: "template", template: e.target.value }, (x) => (x.saved ? "Template saved for the report." : "Re-writing the report with this template…"))}>
              {d.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtin ? "" : " (custom)"}</option>)}
            </select>
          )}
          {r && (
            <select className="mt-select" aria-label="Report language" value={lang} disabled={busy === "lang"} onChange={(e) => translate(e.target.value)}>
              <option value="">{r.language || "Original"}{busy === "lang" ? " (translating…)" : ""}</option>
              {[...new Set([...d.languages, ...LANGS])].filter((l) => l.toLowerCase() !== (r.language || "").toLowerCase()).map((l) => <option key={l} value={l}>{d.languages.includes(l) ? `${l} ✓` : l}</option>)}
            </select>
          )}
          {d.host && !working && d.status !== "recording" && (
            <button className="mt-btn sm" disabled={!!busy} onClick={() => act("regen", "report", { action: "regenerate" }, () => "Re-writing the report…")}><RefreshCw size={13} /> Re-generate</button>
          )}
          <button className="mt-btn sm" onClick={() => { navigator.clipboard?.writeText(window.location.href).catch(() => {}); setMsg("Link copied. People need access to the meeting to open it."); }}><Link2 size={13} /> Copy link</button>
          {d.host && <button className="mt-btn sm" onClick={() => setShareOpen(!shareOpen)}><Share2 size={13} /> Share</button>}
          {lang && <span className="mt-note"><Languages size={12} style={{ verticalAlign: -2 }} /> Translated to {lang}</span>}
        </div>
        {shareOpen && d.host && (
          <form className="mt-card mt-actions" onSubmit={(e) => { e.preventDefault(); act("share", "report", { action: "share", emails: shareTo.split(/[\s,;]+/).filter(Boolean) }, (x) => `Shared with ${x.shared} ${x.shared === 1 ? "person" : "people"}.${x.missing?.length ? ` Not in your organization: ${x.missing.join(", ")}` : ""}`).then(() => setShareTo("")); }}>
            <input className="mt-input" style={{ flex: 1, minWidth: 200 }} placeholder="Emails of people in your organization" value={shareTo} onChange={(e) => setShareTo(e.target.value)} aria-label="Share with" />
            <button className="mt-btn primary" disabled={!shareTo.trim() || !!busy}><Share2 size={14} /> Share report</button>
          </form>
        )}
        {msg && <p className="mt-note" role="status">{msg}</p>}

        {media && (
          <div className="mt-rplayer">
            {media.kind === "video" ? (
              <video ref={(el) => { mediaRef.current = el; }} className="mt-player" controls playsInline preload="metadata" src={`/workspace/api/meet/${d.code}/recordings/${media.id}`}
                onTimeUpdate={(e) => { const t = e.currentTarget.currentTime + off; setNow(t); if (clipEnd !== null && t >= clipEnd) { e.currentTarget.pause(); setClipEnd(null); } }} />
            ) : (
              <audio ref={(el) => { mediaRef.current = el; }} controls preload="metadata" style={{ width: "100%" }} src={`/workspace/api/meet/${d.code}/recordings/${media.id}`}
                onTimeUpdate={(e) => { const t = e.currentTarget.currentTime + off; setNow(t); if (clipEnd !== null && t >= clipEnd) { e.currentTarget.pause(); setClipEnd(null); } }} />
            )}
            {d.media.length > 1 && (
              <select className="mt-select" aria-label="Recording to play" value={media.id} onChange={(e) => setMediaId(e.target.value)}>
                {d.media.map((m, i) => <option key={m.id} value={m.id}>{m.kind === "video" ? "Video" : "Audio"} {i + 1}</option>)}
              </select>
            )}
            {clipEnd !== null && <span className="mt-note">Playing a clip to {clock(clipEnd)}</span>}
          </div>
        )}

        {!r && (
          <div className="mt-card">
            <p style={{ margin: 0 }}>{d.building ? STATUS.processing : STATUS[d.status] ?? d.status}</p>
            {working && <div className="ws-spinner sm" style={{ marginTop: 10 }} />}
            {d.status === "failed" && d.error && <p className="mt-error">{d.error}</p>}
            {d.host && lines.length > 1 && !working && d.status !== "recording" && (
              <button className="mt-btn" style={{ marginTop: 10, marginRight: 8 }} disabled={!!busy} onClick={() => act("cap", "notes", { action: "from_captions" }, () => "Writing the report from the captions…")}>
                <Captions size={14} /> Write the report from the captions
              </button>
            )}
            {d.host && d.status === "failed" && (
              <button className="mt-btn" style={{ marginTop: 10 }} disabled={!!busy} onClick={() => act("regen", "report", { action: "regenerate" }, () => "Trying again…")}>
                <RefreshCw size={14} /> Try again
              </button>
            )}
          </div>
        )}

        {r && (
          <>
            {d.building && <p className="mt-note"><span className="ws-spinner sm" style={{ display: "inline-block", verticalAlign: -3, marginRight: 6 }} /> Re-writing the report… the current one stays until the new one is ready.</p>}
            <section className="mt-card">
              <h2>Summary</h2>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.summary}</p>
              {d.at && <p className="mt-note" style={{ marginBottom: 0 }}>Written {new Date(d.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} by Claude from the meeting audio{d.templates.find((t) => t.id === r.template) ? ` · ${d.templates.find((t) => t.id === r.template)!.name} template` : ""}.</p>}
            </section>

            {r.chapters.length > 0 && (
              <section className="mt-card">
                <h2>Chapters</h2>
                <div className="mt-list">
                  {r.chapters.map((c, i) => (
                    <button key={i} className={`mt-chapter${now >= c.start && now < c.end ? " on" : ""}`} onClick={() => seek(c.start)}>
                      <span className="mt-ts">{clock(c.start)}</span>
                      <span><b>{c.title}</b>{c.summary && <span className="mt-note" style={{ display: "block" }}>{c.summary}</span>}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <div className="mt-rgrid">
              <section className="mt-card">
                <h2>Action items</h2>
                {r.actionItems.length === 0 && <p className="mt-note">No action items.</p>}
                {r.actionItems.map((a, i) => (
                  <div key={i} className="mt-check">
                    {d.host && <input type="checkbox" aria-label={`Pick "${a.title}"`} checked={picked.has(i)} onChange={(e) => setPicked((p) => { const s = new Set(p); if (e.target.checked) s.add(i); else s.delete(i); return s; })} />}
                    <span style={{ flex: 1 }}>
                      <b style={{ fontWeight: 600 }}>{a.title}</b>
                      <span className="mt-note">{a.owner ? ` · ${a.owner}` : ""}{a.due ? ` · by ${a.due}` : ""}</span>
                    </span>
                    {a.start !== null && <button className="mt-ts" onClick={() => seek(a.start!)}>{clock(a.start)}</button>}
                  </div>
                ))}
                {d.host && canTasks && r.actionItems.length > 0 && (
                  <div className="mt-actions" style={{ marginTop: 12 }}>
                    <select className="mt-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                      <option value="">Meeting follow-ups (new project)</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button className="mt-btn primary" disabled={!!busy || picked.size === 0} onClick={() => act("tasks", "notes", { action: "tasks", projectId: projectId || undefined, items: [...picked] }, (x) => `Created ${x.taskIds.length} task${x.taskIds.length === 1 ? "" : "s"}.`)}>
                      <CheckSquare size={14} /> {busy === "tasks" ? "Creating…" : `Make ${picked.size} task${picked.size === 1 ? "" : "s"}`}
                    </button>
                    {d.taskIds.length > 0 && <a className="mt-btn" href="/workspace/tasks">Open Tasks ({d.taskIds.length})</a>}
                  </div>
                )}
              </section>

              <section className="mt-card">
                <h2>Key questions</h2>
                {r.keyQuestions.length === 0 && <p className="mt-note">No key questions.</p>}
                {r.keyQuestions.map((k, i) => (
                  <div key={i} className="mt-check">
                    <span className={`mt-badge ${k.answered ? "ok" : "open"}`}>{k.answered ? "Answered" : "Open"}</span>
                    <span style={{ flex: 1 }}>{k.question}{k.askedBy && <span className="mt-note"> · {k.askedBy}</span>}</span>
                    {k.start !== null && <button className="mt-ts" onClick={() => seek(k.start!)}>{clock(k.start)}</button>}
                  </div>
                ))}
              </section>
            </div>

            <section className="mt-card">
              <h2>Decisions</h2>
              {r.decisions.length ? <ul>{r.decisions.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="mt-note">No decisions were recorded.</p>}
            </section>

            {r.sections.length > 0 && (
              <div className="mt-rgrid">
                {r.sections.map((s, i) => (
                  <section key={i} className="mt-card">
                    <h2>{s.title}</h2>
                    <Body text={s.body} />
                  </section>
                ))}
              </div>
            )}

            {r.highlights.length > 0 && (
              <section className="mt-card">
                <h2>Highlights and clips</h2>
                <div className="mt-list">
                  {r.highlights.map((h, i) => (
                    <div key={i} className="mt-clip">
                      <button className="mt-btn sm" onClick={() => seek(h.start, h.end)} disabled={!media} title={media ? "Play this clip" : "No recording to play"} aria-label={`Play clip ${clock(h.start)} to ${clock(h.end)}`}>
                        <Play size={12} /> {clock(h.start)}–{clock(h.end)}
                      </button>
                      <span>“{h.text}”{h.by && <span className="mt-note"> — {h.by}</span>}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {d.speakers.length > 0 && (
              <section className="mt-card">
                <h2>Speakers</h2>
                <div className="mt-speakers">
                  {d.speakers.map((s) => (
                    <div key={s.name} className="mt-spk">
                      <div className="mt-spk-head">
                        <span className="mt-av" style={{ background: colorFor(s.name) }}>{s.name.slice(0, 1).toUpperCase()}</span>
                        {rename?.from === s.name ? (
                          <form style={{ display: "flex", gap: 4, flex: 1, minWidth: 0 }} onSubmit={(e) => { e.preventDefault(); act("rename", "report", { action: "rename", from: rename.from, to: rename.to }, () => "Renamed.").then(() => setRename(null)); }}>
                            <input className="mt-input" style={{ padding: "4px 8px", fontSize: 13 }} autoFocus value={rename.to} onChange={(e) => setRename({ ...rename, to: e.target.value })} aria-label="New name" />
                            <button className="mt-btn sm" disabled={!rename.to.trim()}>Save</button>
                          </form>
                        ) : (
                          <b style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</b>
                        )}
                        {d.host && !rename && <button className="mt-iconbtn" aria-label={`Rename ${s.name}`} title="Rename speaker" onClick={() => setRename({ from: s.name, to: s.name })}><Pencil size={13} /></button>}
                      </div>
                      <div className="mt-bar"><i style={{ width: `${Math.round((s.talkSec / totalTalk) * 100)}%`, background: colorFor(s.name) }} /></div>
                      <dl>
                        <div><dt>Talk time</dt><dd>{Math.round((s.talkSec / totalTalk) * 100)}% · {mins(s.talkSec)}</dd></div>
                        <div><dt>Pace</dt><dd title="Words per minute; 130–175 is easy to follow">{Math.round(s.wpm)} wpm</dd></div>
                        <div><dt>Fillers</dt><dd>{s.fillers}</dd></div>
                        <div><dt>Questions</dt><dd>{s.questions}</dd></div>
                        <div><dt>Longest monologue</dt><dd>{mins(s.longestMonologueSec)}</dd></div>
                        {s.nonInclusive > 0 && <div><dt>Non-inclusive terms</dt><dd>{s.nonInclusive}</dd></div>}
                        {s.joinedLateSec ? <div><dt>Joined late</dt><dd>{mins(s.joinedLateSec)}</dd></div> : null}
                      </dl>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {r.timeline.length > 1 && (
              <section className="mt-card">
                <h2>Sentiment and engagement</h2>
                <Timeline points={r.timeline} duration={duration} now={now} onSeek={(t) => seek(t)} />
              </section>
            )}
          </>
        )}

        {d.segments.length > 0 && (
          <section className="mt-card">
            <h2><Sparkles size={14} style={{ verticalAlign: -2 }} /> Ask this meeting</h2>
            {asks.map((a, i) => (
              <div key={i} className="mt-ask">
                <p className="q">{a.q}</p>
                {a.error ? <p className="mt-error">{a.error}</p> : a.answer ? <p className="a"><Cited text={a.answer} onSeek={(t) => seek(t)} /></p> : <p className="mt-note">Reading the meeting…</p>}
              </div>
            ))}
            <form className="mt-codeform" onSubmit={ask}>
              <input className="mt-input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What did they decide about the budget?" aria-label="Ask about this meeting" maxLength={1000} />
              <button className="mt-btn primary" disabled={!question.trim()} aria-label="Ask"><Send size={14} /></button>
            </form>
            <p className="mt-note" style={{ marginBottom: 0 }}>Answers come only from this meeting; the times jump to the moment.</p>
          </section>
        )}

        {d.segments.length > 0 && (
          <section className="mt-card">
            <div className="mt-actions" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Transcript</h2>
              <span style={{ position: "relative", flex: "1 1 200px", maxWidth: 320 }}>
                <Search size={14} style={{ position: "absolute", left: 10, top: 10, color: "var(--ix-muted)" }} />
                <input className="mt-input" style={{ paddingLeft: 30, paddingTop: 7, paddingBottom: 7, fontSize: 13.5 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" aria-label="Search the transcript" />
              </span>
            </div>
            {q && <p className="mt-note">{shown.length} matching line{shown.length === 1 ? "" : "s"}</p>}
            <div className="mt-transcript mt-script" ref={scriptRef}>
              {shown.map((s) => (
                <p key={s.seq} data-seq={s.seq} className={now >= s.start && now < s.end + 0.3 ? "on" : ""} onClick={() => seek(s.start)}>
                  <span className="mt-ts">{clock(s.start)}</span> <b style={{ color: colorFor(s.speaker) }}>{s.speaker}</b> {hl(s.text)}
                </p>
              ))}
            </div>
            <a className="mt-btn sm" download={`${d.code}-transcript.txt`} href={`data:text/plain;charset=utf-8,${encodeURIComponent(d.segments.map((s) => `[${clock(s.start)}] ${s.speaker}: ${s.text}`).join("\n"))}`}>
              <Download size={13} /> Download transcript
            </a>
          </section>
        )}

        {r && d.host && (
          <section className="mt-card">
            <h2>Send</h2>
            <div className="mt-actions">
              {canChat && (
                <>
                  {!d.channelId && (
                    <select className="mt-select" value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Channel">
                      <option value="">Pick a channel…</option>
                      {channels.map((c) => <option key={c.id} value={c.id}>{c.kind === "dm" ? "Direct message" : `#${c.name}`}</option>)}
                    </select>
                  )}
                  <button className="mt-btn" disabled={!!busy || (!d.channelId && !channelId)} onClick={() => act("post", "notes", { action: "post", channelId: channelId || undefined }, () => "Posted the notes in chat.")}>
                    <MessageSquare size={14} /> {d.channelId ? "Post in the meeting's chat thread" : "Post to chat"}
                  </button>
                  {d.postedAt && <span className="mt-note">Posted {new Date(d.postedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>}
                </>
              )}
              <button className="mt-btn" disabled={!!busy} onClick={() => act("send", "notes", { action: "send" }, (x) => `Sent to ${x.people} ${x.people === 1 ? "person" : "people"} (${x.emailed} by email).`)}>
                <Mail size={14} /> {busy === "send" ? "Sending…" : "Send to attendees"}
              </button>
              {d.sentAt && <span className="mt-note">Sent {new Date(d.sentAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>}
            </div>
          </section>
        )}

        {board.length > 0 && (
          <section className="mt-card">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0, flex: 1 }}>Whiteboard</h2>
              <button className="mt-btn sm" onClick={() => downloadBoard(board, d.title)}><Download size={14} /> Download PNG</button>
            </div>
            <p className="mt-note">As it was left at the end of the meeting.</p>
            <BoardView items={board} />
          </section>
        )}

        {d.segments.length === 0 && lines.length > 0 && (
          <details className="mt-card" open={!r}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Transcript ({lines.length} lines, from live captions)</summary>
            <div className="mt-transcript">
              {lines.map((l) => (
                <p key={l.id}><span className="mt-note">{new Date(l.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span> <b>{l.name}</b> {l.text}</p>
              ))}
            </div>
          </details>
        )}

        {chat.length > 0 && (
          <details className="mt-card">
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Meeting chat ({chat.length})</summary>
            <div className="mt-transcript">
              {chat.map((c) => (
                <p key={c.id}>
                  <span className="mt-note">{new Date(c.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span> <b>{c.fromName}</b>
                  {c.toName && <span className="mt-note"> → {c.toName} <Lock size={10} /></span>} {c.text}
                  {c.files.map((f) => <a key={f.id} className="mt-chatfile" href={`/workspace/api/meet/${d.code}/files/${f.id}?download=1`}><Download size={12} /> {f.name}</a>)}
                </p>
              ))}
            </div>
          </details>
        )}

        {recs.length > 0 && (
          <details className="mt-card">
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Recordings ({recs.length})</summary>
            <div className="mt-list" style={{ marginTop: 8 }}>
              {recs.map((x) => (
                <div key={x.id} style={{ display: "grid", gap: 8 }}>
                  <div className="mt-row">
                    <Video size={15} />
                    <span className="t">
                      {x.kind === "video" ? "Video recording" : x.kind === "upload" ? (/-upload-video-/.test(x.file) ? "Video file" : "Audio file") : "Audio for notes"} · {new Date(x.startedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                      <span className="mt-note"> · {x.status}{x.size ? ` · ${(x.size / 1048576).toFixed(1)} MB` : ""}{x.error ? ` · ${x.error}` : ""}</span>
                    </span>
                    {x.status === "complete" && (
                      <>
                        {!d.media.some((m) => m.id === x.id) && <button className="mt-btn sm" onClick={() => setPlaying(playing === x.id ? null : x.id)}>{playing === x.id ? "Close" : "Play"}</button>}
                        <a className="mt-btn sm" href={`/workspace/api/meet/${d.code}/recordings/${x.id}?download=1`}><Download size={13} /> Download</a>
                      </>
                    )}
                    {d.host && !["starting", "active", "ending"].includes(x.status) && (
                      delId === x.id ? (
                        <button className="mt-btn sm danger" onClick={async () => {
                          await fetch(`/workspace/api/meet/${d.code}/recordings/${x.id}`, { method: "DELETE" });
                          setDelId(null);
                          load();
                        }}><Trash2 size={13} /> Delete for everyone</button>
                      ) : (
                        <button className="mt-iconbtn" aria-label="Delete recording" title="Delete recording" onClick={() => setDelId(x.id)}><Trash2 size={14} /></button>
                      )
                    )}
                  </div>
                  {playing === x.id && (x.kind === "video" ? <video className="mt-player" controls autoPlay src={`/workspace/api/meet/${d.code}/recordings/${x.id}`} /> : <audio controls autoPlay src={`/workspace/api/meet/${d.code}/recordings/${x.id}`} style={{ width: "100%" }} />)}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
