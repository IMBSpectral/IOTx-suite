"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, CheckSquare, Coffee, Focus, ListChecks, MessageSquareText, Send, Sparkles, Sun, Video, Wand2, X } from "lucide-react";
import { api } from "@/lib/client";

export type Issue = {
  kind: "conflict" | "outside" | "backtoback" | "overload";
  date: string; title: string; detail: string; eventIds: string[];
  fix?: { label: string; eventId: string; occ: string | null; isSeries: boolean; start: string; end: string };
};
type Brief = {
  date: string;
  events: { id: string; occ: string | null; title: string; start: string; end: string; allDay: boolean; color: string; conferenceUrl: string | null; location: string; myResponse: string | null; attendees: number }[];
  meetingMinutes: number;
  gaps: { start: string; end: string; minutes: number }[];
  focus: { start: string; end: string; minutes: number }[];
  issues: Issue[];
  tasks: { id: string; title: string; projectId: string; project: string; due: string; overdue: boolean; priority: number }[];
  prep: { id: string; occ: string | null; notes: string[] }[];
  hours: { start: string; end: string };
};
export type PlanBlock = { taskId: string; title: string; project: string; start: string; end: string; reason: string };
type Action = { id: string; kind: "create" | "update" | "delete"; summary: string; [k: string]: unknown };
type Turn = { role: "user" | "assistant"; text: string; actions?: Action[]; looked?: { kind: string; detail: string }[]; done?: Record<string, "ok" | "no"> };

const t = (s: string) => new Date(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ISSUE_ICON = { conflict: AlertTriangle, outside: Sun, backtoback: Coffee, overload: AlertTriangle };

export default function AiPanel({
  tab, setTab, date, weekIssues, plan, setPlan, onChanged, onPrepare, onOpenEvent, flash, onClose, canCreate,
}: {
  tab: "today" | "ask";
  setTab: (t: "today" | "ask") => void;
  date: string;
  weekIssues: Issue[];
  plan: PlanBlock[] | null;
  setPlan: (p: PlanBlock[] | null) => void;
  onChanged: () => void;
  onPrepare: (id: string, occ: string | null) => void;
  onOpenEvent: (id: string, start: string) => void;
  flash: (m: string) => void;
  onClose: () => void;
  canCreate: boolean;
}) {
  return (
    <aside className="ai-panel" aria-label="Calendar assistant">
      <div className="ai-panel-head">
        <span className="ai-orb"><Sparkles size={14} /></span>
        <div className="ws-seg" role="tablist" aria-label="Assistant">
          <button role="tab" aria-pressed={tab === "today"} aria-selected={tab === "today"} onClick={() => setTab("today")}><Sun size={13} /> Today</button>
          <button role="tab" aria-pressed={tab === "ask"} aria-selected={tab === "ask"} onClick={() => setTab("ask")}><MessageSquareText size={13} /> Ask</button>
        </div>
        <span style={{ flex: 1 }} />
        <button className="ix-iconbtn" onClick={onClose} aria-label="Close assistant"><X size={16} /></button>
      </div>
      {tab === "today" ? (
        <Today date={date} weekIssues={weekIssues} plan={plan} setPlan={setPlan} onChanged={onChanged} onPrepare={onPrepare} onOpenEvent={onOpenEvent} flash={flash} canCreate={canCreate} />
      ) : (
        <Ask onChanged={onChanged} flash={flash} />
      )}
    </aside>
  );
}

function Today({ date, weekIssues, plan, setPlan, onChanged, onPrepare, onOpenEvent, flash, canCreate }: {
  date: string; weekIssues: Issue[]; plan: PlanBlock[] | null; setPlan: (p: PlanBlock[] | null) => void; onChanged: () => void;
  onPrepare: (id: string, occ: string | null) => void; onOpenEvent: (id: string, start: string) => void; flash: (m: string) => void; canCreate: boolean;
}) {
  const [b, setB] = useState<Brief | null>(null);
  const [headline, setHeadline] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planNote, setPlanNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<Brief>(`/calendar/ai/brief?date=${date}`);
      setB(d);
      setHeadline(null);
      api<{ headline: string }>(`/calendar/ai/brief?date=${date}`, { body: {} }).then((h) => setHeadline(h.headline)).catch(() => setHeadline(""));
    } catch (e) {
      flash((e as Error).message);
    }
  }, [date, flash]);
  useEffect(() => {
    setB(null);
    load();
  }, [load]);

  const apply = async (key: string, action: Record<string, unknown>, ok: string) => {
    setBusy(key);
    try {
      await api("/calendar/ai/apply", { body: { action } });
      flash(ok);
      onChanged();
      await load();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const fix = (i: Issue) =>
    i.fix && apply(`fix:${i.fix.eventId}`, { kind: "update", summary: i.fix.label, eventId: i.fix.eventId, occ: i.fix.occ, scope: "this", input: { start: i.fix.start, end: i.fix.end } }, "Moved. Guests were told.");
  const protect = (g: { start: string; end: string }) =>
    apply(`focus:${g.start}`, { kind: "create", summary: "Focus time", input: { title: "Focus time", start: g.start, end: g.end, color: "#16a34a", reminders: [] } }, "Focus time blocked");

  const runPlan = async () => {
    setPlanning(true);
    setPlanNote("");
    try {
      const r = await api<{ blocks: PlanBlock[]; unplaced: { title: string }[]; note?: string }>("/calendar/ai/plan", { body: { date } });
      setPlan(r.blocks);
      setPlanNote(r.note ?? (r.unplaced.length ? `Didn't fit today: ${r.unplaced.map((u) => u.title).join(", ")}` : ""));
      if (!r.blocks.length && r.note) flash(r.note);
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };
  const acceptBlock = async (p: PlanBlock) => {
    await apply(`plan:${p.taskId}`, { kind: "create", summary: p.title, input: { title: `Focus: ${p.title}`, start: p.start, end: p.end, color: "#16a34a", reminders: [5], description: `Focus time for a task.\n/workspace/tasks?task=${p.taskId}` } }, `Focus block added: ${p.title}`);
    setPlan((plan ?? []).filter((x) => x.taskId !== p.taskId));
  };
  const acceptAll = async () => {
    for (const p of plan ?? []) await api("/calendar/ai/apply", { body: { action: { kind: "create", summary: p.title, input: { title: `Focus: ${p.title}`, start: p.start, end: p.end, color: "#16a34a", reminders: [5], description: `Focus time for a task.\n/workspace/tasks?task=${p.taskId}` } } } }).catch(() => {});
    flash(`${plan?.length ?? 0} focus blocks added`);
    setPlan(null);
    onChanged();
    load();
  };

  if (!b)
    return (
      <div className="ai-body">
        <div className="ai-skel" style={{ height: 54 }} />
        <div className="ai-skel" style={{ height: 120 }} />
        <div className="ai-skel" style={{ height: 80 }} />
      </div>
    );

  const timed = b.events.filter((e) => !e.allDay);
  const freeMin = b.gaps.reduce((a, g) => a + g.minutes, 0);
  const isToday = date === new Date().toLocaleDateString("en-CA");
  const later = weekIssues.filter((i) => i.date !== date);

  return (
    <div className="ai-body">
      <div className="ai-hero">
        <small>{isToday ? "Today" : new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "long" })} · {new Date(`${date}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "long" })}</small>
        {headline === null ? <div className="ai-skel line" /> : headline ? <p>{headline}</p> : <p>{timed.length ? `${timed.length} meetings today.` : "No meetings today."}</p>}
        <div className="ai-stats">
          <span><b>{timed.length}</b> meetings</span>
          <span><b>{Math.round(b.meetingMinutes / 6) / 10}h</b> in meetings</span>
          <span><b>{Math.round(freeMin / 6) / 10}h</b> free</span>
        </div>
      </div>

      {b.issues.length > 0 && (
        <section>
          <h4>Needs attention</h4>
          {b.issues.map((i, k) => <IssueRow key={k} i={i} onFix={() => fix(i)} busy={busy === `fix:${i.fix?.eventId}`} />)}
        </section>
      )}

      <section>
        <h4>Agenda</h4>
        {b.events.length === 0 && <p className="ws-muted ai-empty">Nothing scheduled. A good day for deep work.</p>}
        {b.events.map((e) => {
          const notes = b.prep.find((p) => p.id === e.id && p.occ === e.occ)?.notes ?? [];
          return (
            <div key={e.id + (e.occ ?? "")} className="ai-ev">
              <span className="ai-ev-bar" style={{ background: e.color }} />
              <div className="ai-ev-main" role="button" tabIndex={0} onClick={() => onOpenEvent(e.id, e.start)} onKeyDown={(k) => k.key === "Enter" && onOpenEvent(e.id, e.start)}>
                <small>{e.allDay ? "All day" : `${t(e.start)} – ${t(e.end)}`}</small>
                <b>{e.title}</b>
                {notes.length > 0 && <span className="ai-ev-notes">{notes.join(" · ")}</span>}
              </div>
              <div className="ai-ev-acts">
                {e.conferenceUrl && <a className="ix-iconbtn" href={e.conferenceUrl} target="_blank" rel="noreferrer" aria-label="Join"><Video size={15} /></a>}
                {!e.allDay && <button className="ws-btn sm" onClick={() => onPrepare(e.id, e.occ)}><Wand2 size={13} /> Prepare</button>}
              </div>
            </div>
          );
        })}
      </section>

      {canCreate && (
        <section>
          <h4>Plan my day</h4>
          {!plan ? (
            <>
              <p className="ws-muted ai-empty">Place your open tasks into today&apos;s free time as focus blocks. Nothing is saved until you accept.</p>
              <button className="ws-btn primary" onClick={runPlan} disabled={planning}><ListChecks size={15} /> {planning ? "Planning…" : "Plan my day"}</button>
            </>
          ) : (
            <>
              {plan.length === 0 && <p className="ws-muted ai-empty">Nothing to place.</p>}
              {plan.map((p) => (
                <div key={p.taskId} className="ai-plan">
                  <div>
                    <small>{t(p.start)} – {t(p.end)} · {p.project}</small>
                    <b>{p.title}</b>
                    <span>{p.reason}</span>
                  </div>
                  <button className="ix-iconbtn" onClick={() => acceptBlock(p)} aria-label={`Accept ${p.title}`} title="Accept" disabled={!!busy}><Check size={16} /></button>
                  <button className="ix-iconbtn" onClick={() => setPlan(plan.filter((x) => x.taskId !== p.taskId))} aria-label={`Dismiss ${p.title}`} title="Dismiss"><X size={16} /></button>
                </div>
              ))}
              {planNote && <p className="ai-note">{planNote}</p>}
              <div className="ws-row">
                {plan.length > 1 && <button className="ws-btn primary sm" onClick={acceptAll}><Check size={14} /> Accept all</button>}
                <button className="ws-btn sm" onClick={() => setPlan(null)}>Dismiss</button>
              </div>
            </>
          )}
        </section>
      )}

      {(b.focus.length > 0 || b.gaps.length > 0) && (
        <section>
          <h4>Free time</h4>
          {b.focus.map((g) => (
            <div key={g.start} className="ai-gap focus">
              <Focus size={15} />
              <span><b>{t(g.start)} – {t(g.end)}</b> · {Math.round(g.minutes / 6) / 10}h free, good for focus</span>
              {canCreate && <button className="ws-btn sm" onClick={() => protect(g)} disabled={!!busy}>Protect</button>}
            </div>
          ))}
          {b.gaps.filter((g) => g.minutes < 90).slice(0, 4).map((g) => (
            <div key={g.start} className="ai-gap"><ArrowRight size={14} /><span>{t(g.start)} – {t(g.end)} · {g.minutes} min</span></div>
          ))}
        </section>
      )}

      {b.tasks.length > 0 && (
        <section>
          <h4>Tasks due</h4>
          {b.tasks.map((x) => (
            <a key={x.id} className="ai-task" href={`/workspace/tasks?project=${x.projectId}&task=${x.id}`}>
              <CheckSquare size={15} />
              <span>{x.title} <small>· {x.project}</small></span>
              {x.overdue && <em className="ai-tag warn">overdue</em>}
            </a>
          ))}
        </section>
      )}

      {later.length > 0 && (
        <section>
          <h4>Later this week</h4>
          {later.slice(0, 6).map((i, k) => <IssueRow key={k} i={i} withDay onFix={() => fix(i)} busy={busy === `fix:${i.fix?.eventId}`} />)}
        </section>
      )}
    </div>
  );
}

function IssueRow({ i, onFix, busy, withDay }: { i: Issue; onFix: () => void; busy: boolean; withDay?: boolean }) {
  const I = ISSUE_ICON[i.kind];
  return (
    <div className={`ai-issue ${i.kind}`}>
      <I size={15} />
      <div>
        <b>{i.title}</b>
        <span>{withDay ? `${new Date(`${i.date}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · ` : ""}{i.detail}</span>
        {i.fix && (
          <button className="ws-link" style={{ paddingLeft: 0 }} onClick={onFix} disabled={busy}>
            {busy ? "Moving…" : `${i.fix.label}${i.fix.isSeries ? " (this one)" : ""}`}
          </button>
        )}
      </div>
    </div>
  );
}

const SUGGEST = ["What does my week look like?", "When am I free on Thursday?", "Move my 3pm to tomorrow morning", "Cancel Friday's standup"];

function Ask({ onChanged, flash }: { onChanged: () => void; flash: (m: string) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }), [turns, busy]);

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    const history = turns.map((x) => ({ role: x.role, text: x.text }));
    setTurns((ts) => [...ts, { role: "user", text: question }]);
    setQ("");
    setBusy(true);
    try {
      const r = await api<{ answer: string; actions: Action[]; looked: Turn["looked"] }>("/calendar/ai/ask", { body: { question, history } });
      setTurns((ts) => [...ts, { role: "assistant", text: r.answer, actions: r.actions, looked: r.looked, done: {} }]);
    } catch (e) {
      setTurns((ts) => [...ts, { role: "assistant", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (ti: number, a: Action, ok: boolean) => {
    if (ok) {
      try {
        await api("/calendar/ai/apply", { body: { action: a } });
        flash(a.kind === "delete" ? "Cancelled" : a.kind === "update" ? "Changed" : "Created");
        onChanged();
      } catch (e) {
        flash((e as Error).message);
        return;
      }
    }
    setTurns((ts) => ts.map((x, i) => (i === ti ? { ...x, done: { ...(x.done ?? {}), [a.id]: ok ? "ok" : "no" } } : x)));
  };

  return (
    <div className="ai-ask">
      <div className="ai-chat">
        {turns.length === 0 && (
          <div className="ai-welcome">
            <span className="ai-orb lg"><Sparkles size={18} /></span>
            <b>Ask your calendar</b>
            <p>Questions are answered from your real calendar. Changes come back as drafts you confirm.</p>
            <div className="ai-suggest">
              {SUGGEST.map((s) => <button key={s} className="ws-chip" onClick={() => ask(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {turns.map((x, i) => (
          <div key={i} className={`ai-msg ${x.role}`}>
            {x.looked && x.looked.length > 0 && <small className="ai-looked">Checked {x.looked.map((l) => (l.kind === "list" ? `events ${l.detail}` : `free time (${l.detail})`)).join(", ")}</small>}
            <div className="ai-text">{x.text}</div>
            {x.actions?.map((a) => (
              <div key={a.id} className={`ai-action ${a.kind}${x.done?.[a.id] ? ` ${x.done[a.id]}` : ""}`}>
                <span>{a.summary}</span>
                {x.done?.[a.id] ? (
                  <em>{x.done[a.id] === "ok" ? "Done" : "Dismissed"}</em>
                ) : (
                  <span className="ws-row" style={{ gap: 6 }}>
                    <button className={`ws-btn sm ${a.kind === "delete" ? "danger" : "primary"}`} onClick={() => decide(i, a, true)}>{a.kind === "delete" ? "Cancel event" : "Confirm"}</button>
                    <button className="ws-btn sm ghost" onClick={() => decide(i, a, false)}>Dismiss</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
        {busy && <div className="ai-msg assistant"><span className="ai-thinking"><i /><i /><i /> Looking at your calendar</span></div>}
        <div ref={end} />
      </div>
      <form className="ai-askbox" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about your schedule…" aria-label="Ask about your schedule" disabled={busy} />
        <button className="ix-iconbtn" type="submit" disabled={busy || !q.trim()} aria-label="Send"><Send size={16} /></button>
      </form>
    </div>
  );
}
