"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Send, Trash2 } from "lucide-react";
import { meetApi } from "../api";

type Src = { ref: string; kind: string; title: string; href: string; at?: string };
type Msg = { id?: string; role: "user" | "assistant"; text: string; sources?: Src[] };
type Thread = { id: string; title: string; folderId: string | null; updatedAt: string };

/** Turn [M1] / [T2] / [3] citations into links to their sources (meetings open at the moment). */
function Cited({ text, sources }: { text: string; sources: Src[] }) {
  const parts = text.split(/(\[(?:[MTC]\d+|\d+)\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[([MTC]?\d+)\]$/.exec(p);
        const s = m && sources.find((x) => x.ref === m[1]);
        return s ? (
          s.href ? (
            <a key={i} className="cite" href={s.href} title={s.title}>
              {m![1]}
            </a>
          ) : (
            <span key={i} className="cite" title={s.title}>
              {m![1]}
            </span>
          )
        ) : (
          <Fragment key={i}>{p}</Fragment>
        );
      })}
    </>
  );
}

/**
 * Ask across meetings: the conversation and its form. Used by the full page
 * (with chat history) and the side panel. folderId keeps questions inside
 * one folder.
 */
function useAsk({ compact, folderId }: { compact: boolean; folderId?: string }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const loadThreads = () => meetApi<{ threads: Thread[] }>(`/read/ask/threads${folderId ? `?folder=${folderId}` : ""}`).then((d) => setThreads(d.threads)).catch(() => {});
  useEffect(() => {
    meetApi<{ prompts: string[] }>("/read/ask/suggestions").then((d) => setPrompts(d.prompts)).catch(() => {});
    if (!compact) loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [msgs.length, busy]);

  const open = async (id: string) => {
    setThreadId(id);
    setErr("");
    const d = await meetApi<{ thread: { messages: Msg[] } }>(`/read/ask/threads/${id}`);
    setMsgs(d.thread.messages);
  };
  const fresh = () => {
    setThreadId(null);
    setMsgs([]);
    setErr("");
  };
  const remove = async (id: string) => {
    await meetApi(`/read/ask/threads/${id}`, { method: "DELETE" }).catch(() => {});
    if (id === threadId) fresh();
    loadThreads();
  };
  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setErr("");
    setQ("");
    setMsgs((m) => [...m, { role: "user", text: question }]);
    try {
      const d = await meetApi<{ threadId: string; message: Msg }>("/read/ask", { body: { question, threadId, folderId } });
      setThreadId(d.threadId);
      setMsgs((m) => [...m, d.message]);
      if (!compact) loadThreads();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chat = (
    <div className="rd-chat" aria-live="polite">
      {!msgs.length && (
        <>
          <p className="rd-help" style={{ margin: 0 }}>
            Ask about anything said in your meetings{folderId ? " in this folder" : ""}. Answers cite the meeting and moment{folderId ? "" : ", plus your tasks, chat and the company knowledge base"}. Only reports you can open are used.
          </p>
          <div className="rd-prompts">
            {prompts.map((p) => (
              <button key={p} onClick={() => send(p)} disabled={busy}>
                {p}
              </button>
            ))}
          </div>
        </>
      )}
      {msgs.map((m, i) => (
        <div key={m.id ?? i} className={`rd-msg ${m.role}`}>
          {m.role === "assistant" ? <Cited text={m.text} sources={m.sources ?? []} /> : m.text}
          {m.role === "assistant" && !!m.sources?.length && (
            <div className="rd-srcs">
              {m.sources.map((s) =>
                s.href ? (
                  <a key={s.ref} href={s.href} title={s.title}>
                    {s.ref} · {s.title}
                  </a>
                ) : (
                  <span key={s.ref} title={s.title}>
                    {s.ref} · {s.title}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      {busy && <div className="rd-msg assistant">Searching your meetings…</div>}
      {err && <p className="mt-error">{err}</p>}
      <div ref={end} />
    </div>
  );
  const form = (
    <form className="rd-ask-form" onSubmit={(e) => { e.preventDefault(); send(q); }}>
      <textarea
        className="mt-input" value={q} rows={2} placeholder={folderId ? "Ask about this folder…" : "Ask anything about your meetings…"} aria-label="Question" maxLength={2000}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(q); } }}
      />
      <button className="mt-btn primary" disabled={busy || !q.trim()} aria-label="Send"><Send size={15} /></button>
    </form>
  );
  return { chat, form, fresh, threads, threadId, open, remove };
}

export default function Ask({ folderId }: { folderId?: string }) {
  const { chat, form, fresh, threads, threadId, open, remove } = useAsk({ compact: false, folderId });
  return (
    <div className="rd-ask-layout">
      <aside className="mt-card" style={{ padding: 10 }}>
        <button className="mt-btn sm" style={{ width: "100%", justifyContent: "center", marginBottom: 8 }} onClick={fresh}><MessageSquarePlus size={14} /> New chat</button>
        <div className="rd-threads">
          {threads.length === 0 && <span className="rd-empty">No chats yet.</span>}
          {threads.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center" }}>
              <button className={t.id === threadId ? "on" : ""} style={{ flex: 1, minWidth: 0 }} onClick={() => open(t.id)} title={t.title}>{t.title}</button>
              <button className="mt-iconbtn" aria-label="Delete chat" onClick={() => remove(t.id)} style={{ padding: 4 }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </aside>
      <section className="mt-card" style={{ display: "grid", gap: 14 }}>
        {chat}
        {form}
      </section>
    </div>
  );
}

/** The same chat, laid out for the side panel. */
export function AskCompact({ folderId }: { folderId?: string }) {
  const { chat, form } = useAsk({ compact: true, folderId });
  return (
    <>
      <div className="scroll">{chat}</div>
      <footer>{form}</footer>
    </>
  );
}
