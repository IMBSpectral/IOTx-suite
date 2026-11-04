"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDataChannel } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { BarChart3, Check, ChevronUp, Download, Lock, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import { meetApi } from "./api";

/** What every panel needs to know about the room and the person. */
export type Ctx = {
  code: string;
  guest: string | null;
  identity: string;
  hostLike: boolean;
  room: number;
  participants: Participant[];
  toast: (text: string) => void;
};

const dec = new TextDecoder();
const parse = (p: Uint8Array) => {
  try {
    return JSON.parse(dec.decode(p)) as Record<string, any>;
  } catch {
    return {};
  }
};
const time = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fileHref = (code: string, id: string, guest: string | null, download = false) =>
  `/workspace/api/meet/${code}/files/${id}?${guest ? `k=${encodeURIComponent(guest)}&` : ""}${download ? "download=1" : ""}`;

// ── Chat ───────────────────────────────────────────────────────────────────

export type ChatMsg = { id: string; from: string; fromName: string; to: string | null; toName: string | null; text: string; files: { id: string; name: string; type: string; size: number }[]; at: string };

/** The chat log is kept by the room (so the unread badge works with the panel closed). */
export function useMeetChat(ctx: Pick<Ctx, "code" | "guest" | "identity" | "toast">, open: boolean) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [seen, setSeen] = useState(0);
  const add = useCallback((m: ChatMsg) => setMsgs((xs) => (xs.some((x) => x.id === m.id) ? xs : [...xs, m])), []);
  useEffect(() => {
    meetApi<{ messages: ChatMsg[] }>(`/${ctx.code}/chat`, { guest: ctx.guest }).then((d) => setMsgs(d.messages)).catch(() => {});
  }, [ctx.code, ctx.guest]);
  useDataChannel("iotx.chat", (msg) => {
    const d = parse(msg.payload);
    if (d.type !== "message" || !d.message) return;
    const m = d.message as ChatMsg;
    add(m);
    if (!open && m.from !== ctx.identity) ctx.toast(`💬 ${m.fromName}${m.to ? " (privately)" : ""}: ${m.text.slice(0, 120) || "sent a file"}`);
  });
  useEffect(() => {
    if (open) setSeen(msgs.length);
  }, [open, msgs.length]);
  return { msgs, add, unread: open ? 0 : Math.max(0, msgs.length - seen) };
}

export function ChatPanel({ ctx, chat, to, setTo }: { ctx: Ctx; chat: ReturnType<typeof useMeetChat>; to: string; setTo: (x: string) => void }) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<{ id: string; name: string; size: number; type: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [chat.msgs.length]);
  const others = ctx.participants.filter((p) => p.identity !== ctx.identity);
  const upload = async (list: File[]) => {
    for (const f of list.slice(0, 10)) {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`/workspace/api/meet/${ctx.code}/files`, { method: "POST", body: fd, headers: ctx.guest ? { "x-meet-guest": ctx.guest } : undefined });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) ctx.toast(d.error ?? "Upload failed");
      else setFiles((xs) => [...xs, d.file]);
    }
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || busy) return;
    setBusy(true);
    try {
      const r = await meetApi<{ message: ChatMsg }>(`/${ctx.code}/chat`, { body: { text, to: to || undefined, fileIds: files.map((f) => f.id), room: ctx.room }, guest: ctx.guest });
      chat.add(r.message);
      setDraft("");
      setFiles([]);
    } catch (err) {
      ctx.toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mt-side-body" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload([...e.dataTransfer.files]); }}>
        {chat.msgs.length === 0 && <p className="mt-note">Messages are saved with the meeting, so people who were in it can read them later.</p>}
        {chat.msgs.map((m) => (
          <div key={m.id} className={`mt-msg${m.to ? " private" : ""}`}>
            <span className="meta">
              <b>{m.from === ctx.identity ? "You" : m.fromName}</b>
              {m.to && <> → <b>{m.to === ctx.identity ? "you" : m.toName}</b> <Lock size={10} /> privately</>} · {time(m.at)}
            </span>
            {m.text && <span className="text">{m.text}</span>}
            {m.files.map((f) =>
              /^image\//.test(f.type) ? (
                <a key={f.id} href={fileHref(ctx.code, f.id, ctx.guest)} target="_blank" rel="noreferrer" className="mt-chatimg"><img src={fileHref(ctx.code, f.id, ctx.guest)} alt={f.name} /></a>
              ) : (
                <a key={f.id} className="mt-chatfile" href={fileHref(ctx.code, f.id, ctx.guest, true)}><Download size={14} /> {f.name} <small>{size(f.size)}</small></a>
              ),
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="mt-compose col" onSubmit={send}>
        <div className="row">
          <label className="mt-note" htmlFor="mt-to">To</label>
          <select id="mt-to" className="mt-select" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Everyone</option>
            {others.map((p) => <option key={p.identity} value={p.identity}>{p.name || "Guest"} (privately)</option>)}
          </select>
        </div>
        {files.length > 0 && (
          <div className="row wrap">
            {files.map((f) => <span key={f.id} className="mt-pill">{f.name} <button type="button" className="mt-x" onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`}><X size={11} /></button></span>)}
          </div>
        )}
        <div className="row">
          <button type="button" className="mt-iconbtn" onClick={() => fileIn.current?.click()} aria-label="Attach a file" title="Attach a file"><Paperclip size={16} /></button>
          <input ref={fileIn} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload([...e.target.files]); e.target.value = ""; }} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={to ? "Private message" : "Message everyone"} maxLength={2000} aria-label="Message"
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); upload([...e.clipboardData.files]); } }} />
          <button className="mt-btn primary" disabled={busy || (!draft.trim() && !files.length)} aria-label="Send"><Send size={15} /></button>
        </div>
      </form>
    </>
  );
}

// ── Polls ──────────────────────────────────────────────────────────────────

type Poll = { id: string; question: string; options: string[]; multi: boolean; anonymous: boolean; status: string; shared: boolean; voted: number; mine: number[] | null; results: number[] | null; voters: { name: string; choices: number[] }[] | null };

export function PollsPanel({ ctx }: { ctx: Ctx }) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [draft, setDraft] = useState<{ question: string; options: string[]; multi: boolean; anonymous: boolean } | null>(null);
  const [pick, setPick] = useState<Record<string, number[]>>({});
  const load = useCallback(() => meetApi<{ polls: Poll[] }>(`/${ctx.code}/polls`, { guest: ctx.guest }).then((d) => setPolls(d.polls)).catch(() => {}), [ctx.code, ctx.guest]);
  useEffect(() => { load(); }, [load]);
  useDataChannel("iotx.poll", () => load());
  const act = async (b: Record<string, unknown>) => {
    try {
      await meetApi(`/${ctx.code}/polls`, { body: b, guest: ctx.guest });
      load();
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  };
  return (
    <div className="mt-side-body">
      {ctx.hostLike && !draft && <button className="mt-btn" onClick={() => setDraft({ question: "", options: ["", ""], multi: false, anonymous: true })}><Plus size={14} /> New poll</button>}
      {draft && (
        <div className="mt-card">
          <input className="mt-input" autoFocus placeholder="Question" value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} aria-label="Question" />
          {draft.options.map((o, i) => (
            <div key={i} className="row">
              <input className="mt-input" placeholder={`Answer ${i + 1}`} value={o} onChange={(e) => setDraft({ ...draft, options: draft.options.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`Answer ${i + 1}`} />
              {draft.options.length > 2 && <button type="button" className="mt-iconbtn" onClick={() => setDraft({ ...draft, options: draft.options.filter((_, j) => j !== i) })} aria-label="Remove answer"><X size={14} /></button>}
            </div>
          ))}
          {draft.options.length < 10 && <button type="button" className="mt-btn sm" onClick={() => setDraft({ ...draft, options: [...draft.options, ""] })}><Plus size={13} /> Answer</button>}
          <label className="mt-check"><input type="checkbox" checked={draft.multi} onChange={(e) => setDraft({ ...draft, multi: e.target.checked })} /> Allow more than one answer</label>
          <label className="mt-check"><input type="checkbox" checked={draft.anonymous} onChange={(e) => setDraft({ ...draft, anonymous: e.target.checked })} /> Anonymous</label>
          <div className="row">
            <button className="mt-btn sm" onClick={() => setDraft(null)}>Cancel</button>
            <span style={{ flex: 1 }} />
            <button className="mt-btn sm" onClick={async () => { await act({ action: "create", ...draft }); setDraft(null); }}>Save draft</button>
            <button className="mt-btn sm primary" onClick={async () => { await act({ action: "create", ...draft, open: true }); setDraft(null); }}>Launch</button>
          </div>
        </div>
      )}
      {polls.length === 0 && !draft && <p className="mt-note">{ctx.hostLike ? "Ask everyone a quick question." : "No polls yet."}</p>}
      {polls.map((p) => {
        const total = p.results ? Math.max(1, p.voted) : 1;
        const chosen = pick[p.id] ?? p.mine ?? [];
        return (
          <div key={p.id} className="mt-card">
            <div className="row"><BarChart3 size={15} /><b style={{ flex: 1 }}>{p.question}</b><span className="mt-pill">{p.status === "open" ? "Live" : p.status === "draft" ? "Draft" : "Ended"}</span></div>
            {p.options.map((o, i) => (
              <label key={i} className="mt-option">
                {p.status === "open" && (
                  <input type={p.multi ? "checkbox" : "radio"} name={`poll-${p.id}`} checked={chosen.includes(i)}
                    onChange={(e) => setPick({ ...pick, [p.id]: p.multi ? (e.target.checked ? [...chosen, i] : chosen.filter((x) => x !== i)) : [i] })} />
                )}
                <span style={{ flex: 1 }}>{o}</span>
                {p.results && <small>{p.results[i]} · {Math.round((100 * p.results[i]) / total)}%</small>}
                {p.results && <span className="bar" style={{ width: `${(100 * p.results[i]) / total}%` }} />}
              </label>
            ))}
            <small className="mt-note">{p.voted} {p.voted === 1 ? "vote" : "votes"}{p.multi ? " · several answers allowed" : ""}{p.anonymous ? " · anonymous" : ""}{p.mine ? " · you voted" : ""}</small>
            {p.voters && p.voters.length > 0 && <small className="mt-note">{p.voters.map((v) => `${v.name}: ${v.choices.map((c) => p.options[c]).join(", ")}`).join(" · ")}</small>}
            <div className="row wrap">
              {p.status === "open" && <button className="mt-btn sm primary" disabled={!chosen.length} onClick={() => act({ action: "vote", id: p.id, choices: chosen })}>{p.mine ? "Change vote" : "Vote"}</button>}
              {ctx.hostLike && p.status === "draft" && <button className="mt-btn sm primary" onClick={() => act({ action: "open", id: p.id })}>Launch</button>}
              {ctx.hostLike && p.status === "open" && <button className="mt-btn sm" onClick={() => act({ action: "close", id: p.id })}>End poll</button>}
              {ctx.hostLike && p.status !== "draft" && <button className="mt-btn sm" onClick={() => act({ action: p.shared ? "unshare" : "share", id: p.id })}>{p.shared ? "Stop sharing results" : "Share results"}</button>}
              {ctx.hostLike && <button className="mt-iconbtn" onClick={() => act({ action: "delete", id: p.id })} aria-label="Delete poll"><Trash2 size={14} /></button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Q&A ────────────────────────────────────────────────────────────────────

type Q = { id: string; text: string; name: string; mine: boolean; anonymous: boolean; votes: number; upvoted: boolean; answer: string; status: string; at: string };

export function QAPanel({ ctx }: { ctx: Ctx }) {
  const [qs, setQs] = useState<Q[]>([]);
  const [text, setText] = useState("");
  const [anon, setAnon] = useState(false);
  const [answering, setAnswering] = useState<{ id: string; text: string } | null>(null);
  const load = useCallback(() => meetApi<{ questions: Q[] }>(`/${ctx.code}/qa`, { guest: ctx.guest }).then((d) => setQs(d.questions)).catch(() => {}), [ctx.code, ctx.guest]);
  useEffect(() => { load(); }, [load]);
  useDataChannel("iotx.qa", () => load());
  const act = async (b: Record<string, unknown>) => {
    try {
      await meetApi(`/${ctx.code}/qa`, { body: b, guest: ctx.guest });
      load();
      return true;
    } catch (e) {
      ctx.toast((e as Error).message);
      return false;
    }
  };
  return (
    <>
      <div className="mt-side-body">
        {qs.length === 0 && <p className="mt-note">Ask the hosts a question. Others can upvote it.</p>}
        {qs.map((q) => (
          <div key={q.id} className={`mt-card${q.status === "answered" ? " done" : ""}${q.status === "dismissed" ? " dim" : ""}`}>
            <div className="row">
              <button className={`mt-vote${q.upvoted ? " on" : ""}`} onClick={() => act({ action: "upvote", id: q.id })} disabled={q.mine} aria-label={`Upvote (${q.votes})`}><ChevronUp size={14} />{q.votes}</button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="text">{q.text}</span>
                <small className="mt-note">{q.name}{q.mine ? " (you)" : ""} · {time(q.at)}{q.status === "dismissed" ? " · dismissed" : ""}</small>
              </div>
            </div>
            {q.answer && <div className="mt-answer"><Check size={13} /> {q.answer}</div>}
            {ctx.hostLike && (answering?.id === q.id ? (
              <div className="row">
                <input className="mt-input" autoFocus value={answering.text} onChange={(e) => setAnswering({ ...answering, text: e.target.value })} placeholder="Type an answer, or leave empty for answered live" aria-label="Answer" />
                <button className="mt-btn sm primary" onClick={async () => { if (await act({ action: "answer", id: q.id, answer: answering.text })) setAnswering(null); }}>Done</button>
              </div>
            ) : (
              <div className="row wrap">
                {q.status !== "answered" && <button className="mt-btn sm" onClick={() => setAnswering({ id: q.id, text: "" })}>Answer</button>}
                {q.status === "open" && <button className="mt-btn sm" onClick={() => act({ action: "dismiss", id: q.id })}>Dismiss</button>}
                {q.status !== "open" && <button className="mt-btn sm" onClick={() => act({ action: "reopen", id: q.id })}>Reopen</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <form className="mt-compose col" onSubmit={async (e) => { e.preventDefault(); if (text.trim() && (await act({ action: "ask", text, anonymous: anon }))) setText(""); }}>
        <label className="mt-check"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} /> Ask anonymously</label>
        <div className="row">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask a question" maxLength={500} aria-label="Question" />
          <button className="mt-btn primary" disabled={!text.trim()}>Ask</button>
        </div>
      </form>
    </>
  );
}

// ── Breakout rooms ─────────────────────────────────────────────────────────

export type BoState = { breakout: { open: boolean; allowChoose: boolean; rooms: { n: number; name: string; count: number; members?: { identity: string; name: string }[] }[] } | null; mine: number | null; hostLike: boolean };

export function BreakoutPanel({ ctx, state, reload, onJoin }: { ctx: Ctx; state: BoState | null; reload: () => void; onJoin: (n: number) => void }) {
  const [count, setCount] = useState(2);
  const [auto, setAuto] = useState(true);
  const [choose, setChoose] = useState(false);
  const [msg, setMsg] = useState("");
  const act = async (b: Record<string, unknown>) => {
    try {
      await meetApi(`/${ctx.code}/breakout`, { body: b, guest: ctx.guest });
      reload();
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  };
  const bo = state?.breakout;
  const assigned = new Map<string, number>();
  for (const r of bo?.rooms ?? []) for (const m of r.members ?? []) assigned.set(m.identity, r.n);
  const people = ctx.participants.filter((p) => p.identity !== ctx.identity);
  return (
    <div className="mt-side-body">
      {!bo ? (
        ctx.hostLike ? (
          <div className="mt-card">
            <b>Breakout rooms</b>
            <div className="row"><label className="mt-note" htmlFor="bo-n">Rooms</label><input id="bo-n" className="mt-input" type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 80 }} /></div>
            <label className="mt-check"><input type="radio" checked={auto} onChange={() => setAuto(true)} /> Assign people automatically</label>
            <label className="mt-check"><input type="radio" checked={!auto} onChange={() => setAuto(false)} /> I'll assign people</label>
            <label className="mt-check"><input type="checkbox" checked={choose} onChange={(e) => setChoose(e.target.checked)} /> Let people choose their room</label>
            <button className="mt-btn primary" onClick={() => act({ action: "create", count, auto, allowChoose: choose, identities: ctx.participants.map((p) => p.identity) })}>Create rooms</button>
          </div>
        ) : (
          <p className="mt-note">The host hasn't opened breakout rooms.</p>
        )
      ) : (
        <>
          <div className="row"><b style={{ flex: 1 }}>{bo.rooms.length} breakout {bo.rooms.length === 1 ? "room" : "rooms"}</b><span className="mt-pill">{bo.open ? "Open" : "Not open yet"}</span></div>
          {bo.rooms.map((r) => (
            <div key={r.n} className="mt-card">
              <div className="row">
                <b style={{ flex: 1 }}>{r.name}</b>
                <small className="mt-note">{r.count} {r.count === 1 ? "person" : "people"}</small>
                {bo.open && ctx.room !== r.n && (ctx.hostLike || bo.allowChoose || state?.mine === r.n) && <button className="mt-btn sm primary" onClick={() => onJoin(r.n)}>Join</button>}
                {ctx.room === r.n && <span className="mt-pill">You're here</span>}
              </div>
              {r.members && r.members.length > 0 && <small className="mt-note">{r.members.map((m) => m.name).join(", ")}</small>}
            </div>
          ))}
          {ctx.room !== 0 && <button className="mt-btn" onClick={() => onJoin(0)}>Return to the main room</button>}
          {ctx.hostLike && (
            <>
              {people.length > 0 && (
                <div className="mt-card">
                  <b>Assign people</b>
                  {people.map((p) => (
                    <div key={p.identity} className="row">
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name || "Guest"}</span>
                      <select className="mt-select" value={assigned.get(p.identity) ?? ""} aria-label={`Room for ${p.name}`} onChange={(e) => act({ action: "assign", identity: p.identity, n: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">Not assigned</option>
                        {bo.rooms.map((r) => <option key={r.n} value={r.n}>{r.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
              <label className="mt-check"><input type="checkbox" checked={bo.allowChoose} onChange={(e) => act({ action: "options", allowChoose: e.target.checked })} /> Let people choose their room</label>
              {bo.open ? (
                <>
                  <div className="row">
                    <input className="mt-input" placeholder="Message to every room" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Message to every room" />
                    <button className="mt-btn sm" disabled={!msg.trim()} onClick={async () => { await act({ action: "broadcast", text: msg }); setMsg(""); }}>Send</button>
                  </div>
                  <button className="mt-btn danger" onClick={() => act({ action: "close" })}>Close all rooms</button>
                </>
              ) : (
                <div className="row">
                  <button className="mt-btn primary" onClick={() => act({ action: "open" })}>Open all rooms</button>
                  <button className="mt-btn" onClick={() => act({ action: "delete" })}>Start over</button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// The whiteboard lives in Board.tsx.
export { Whiteboard } from "./Board";
