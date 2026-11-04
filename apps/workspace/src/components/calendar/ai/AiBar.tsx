"use client";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Check, Clock, MapPin, Repeat, Sparkles, Users, Video, X } from "lucide-react";
import { api } from "@/lib/client";
import { draftNew, type Draft } from "../EventEditor";
import { dateKey, timeKey, addDays } from "../types";

type Person = { id: string; name: string; email: string };
type Match = { matched: Person[]; external: { email: string }[]; unmatched: string[]; ambiguous: { mention: string; options: Person[] }[] };
export type AiDraft = {
  title: string; start: string; end: string; allDay: boolean; tz: string; rrule: string | null; location: string; description: string; video: boolean;
  attendees: { userId: string | null; name: string; email: string }[]; timeSource: "given" | "suggested"; durationDefaulted: boolean;
};
type Slot = { start: string; end: string; score: number; reason: string };
type Result =
  | { kind: "event"; draft: AiDraft; match: Match; notes: string[]; conflicts: { name: string }[] }
  | { kind: "slots"; title: string; minutes: number; from: string; to: string; people: Person[]; match: Match; slots: Slot[]; notes: string[] }
  | { kind: "unclear"; notes: string[] };

const EXAMPLES = [
  "Review with Priya and Ravi Friday 3pm for 45 min at Pune office",
  "Standup every Monday 10am",
  "Find the best time for me, Priya and Ravi next week, 1 hour",
  "Call with the supplier tomorrow after lunch",
];

const DAYS: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
export function repeatText(rrule: string | null) {
  if (!rrule) return "";
  const f = /FREQ=(\w+)/.exec(rrule)?.[1];
  const by = /BYDAY=([A-Z,]+)/.exec(rrule)?.[1];
  const iv = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1);
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[f ?? ""] ?? "time";
  return `Every ${iv > 1 ? `${iv} ${unit}s` : unit}${by ? ` on ${by.split(",").map((d) => DAYS[d] ?? d).join(", ")}` : ""}`;
}
const when = (s: string, e: string, allDay: boolean) => {
  const a = new Date(s), b = new Date(e);
  if (allDay) return `${new Date(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })} · all day`;
  return `${a.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })} · ${a.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${b.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
};

/** An AI draft -> the full event editor ("Edit details"). */
export function editorDraft(d: AiDraft, calendarId: string): Draft {
  const s = new Date(d.start), e = new Date(d.end);
  const base = d.allDay
    ? draftNew(new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()), new Date(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()), true, calendarId)
    : { ...draftNew(s, e, false, calendarId), sDate: dateKey(s), sTime: timeKey(s), eDate: dateKey(e), eTime: timeKey(e) };
  return {
    ...base,
    title: d.title,
    location: d.location,
    description: d.description,
    rrule: d.rrule ?? null,
    guests: d.attendees.map((a) => ({ userId: a.userId ?? undefined, email: a.email, name: a.name })),
  };
}
void addDays;

/**
 * "Add with AI" at the top of Calendar: type an event or ask for the best
 * time; Claude reads it, people are matched to the workspace, and a card shows
 * exactly what will be created. One click creates it.
 */
export default function AiBar({ calendarId, onCreated, onEdit, flash, focusSignal }: {
  calendarId: string;
  onCreated: (start: string) => void;
  onEdit: (d: Draft) => void;
  flash: (m: string) => void;
  focusSignal: number;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [video, setVideo] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [ph, setPh] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState<Record<string, string>>({});

  useEffect(() => {
    const t = setInterval(() => setPh((x) => (x + 1) % EXAMPLES.length), 4500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (focusSignal) input.current?.focus();
  }, [focusSignal]);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setRes(null);
    setPick({});
    try {
      const r = await api<Result>("/calendar/ai/quick", { body: { text } });
      setRes(r);
      setVideo("");
    } catch (err) {
      flash((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const extraPeople = (m: Match) => Object.values(pick).map((id) => m.ambiguous.flatMap((a) => a.options).find((o) => o.id === id)).filter(Boolean) as Person[];

  const create = async (d: AiDraft, m: Match) => {
    setSaving("event");
    const attendees = [...d.attendees.map((a) => (a.userId ? { userId: a.userId } : { email: a.email, name: a.name })), ...extraPeople(m).map((p) => ({ userId: p.id }))];
    try {
      await api("/calendar/ai/apply", {
        body: {
          action: {
            kind: "create",
            summary: d.title,
            input: {
              calendarId, title: d.title, start: d.allDay ? d.start.slice(0, 10) : d.start, end: d.allDay ? d.end.slice(0, 10) : d.end, allDay: d.allDay, tz: d.tz, rrule: d.rrule,
              location: d.location, description: d.description, reminders: d.allDay ? [] : [10], attendees, conferenceUrl: /^https?:\/\//.test(video.trim()) ? video.trim() : null,
            },
          },
        },
      });
      flash(`Created “${d.title}”`);
      onCreated(d.start);
      setRes(null);
      setText("");
    } catch (err) {
      flash((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const book = async (r: Extract<Result, { kind: "slots" }>, s: Slot) => {
    setSaving(s.start);
    try {
      await api("/calendar/ai/apply", {
        body: { action: { kind: "create", summary: r.title, input: { calendarId, title: r.title, start: s.start, end: s.end, reminders: [10], attendees: [...r.people, ...extraPeople(r.match)].map((p) => ({ userId: p.id })) } } },
      });
      flash(`Booked “${r.title}” · invites sent`);
      onCreated(s.start);
      setRes(null);
      setText("");
    } catch (err) {
      flash((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="ai-bar">
      <form className={`ai-input${busy ? " busy" : ""}`} onSubmit={run}>
        <Sparkles size={16} className="ai-spark" />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (setRes(null), (e.target as HTMLInputElement).blur())}
          placeholder={`Add with AI: “${EXAMPLES[ph]}”`}
          aria-label="Add an event or find a time, in your own words"
        />
        {busy ? <span className="ai-thinking"><i /><i /><i /> Reading</span> : text.trim() && <button className="ws-btn primary sm" type="submit">Go</button>}
      </form>

      {res && (
        <div className="ai-card" role="dialog" aria-label="Suggested by AI">
          <button className="ix-iconbtn ai-x" onClick={() => setRes(null)} aria-label="Dismiss"><X size={16} /></button>
          {res.kind === "unclear" && <p className="ws-muted" style={{ margin: 0 }}>{res.notes.join(" ")}</p>}

          {res.kind === "event" && (
            <>
              <div className="ai-kicker"><Sparkles size={13} /> New event · check and create</div>
              <h3>{res.draft.title}</h3>
              <ul className="ai-facts">
                <li><Clock size={15} /><span>{when(res.draft.start, res.draft.end, res.draft.allDay)}{res.draft.timeSource === "suggested" && <em className="ai-tag">suggested</em>}</span></li>
                {res.draft.rrule && <li><Repeat size={15} /><span>{repeatText(res.draft.rrule)}</span></li>}
                {(res.draft.attendees.length > 0 || res.match.ambiguous.length > 0) && (
                  <li><Users size={15} /><span className="ai-people">
                    {res.draft.attendees.map((a) => <span key={a.email} className="ws-chip" title={a.email}>{a.name || a.email}{!a.userId && <small className="ws-muted"> · guest</small>}</span>)}
                    {res.match.ambiguous.map((a) => (
                      <select key={a.mention} className="ws-select ai-pick" value={pick[a.mention] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [a.mention]: e.target.value }))} aria-label={`Which ${a.mention}?`}>
                        <option value="">Which “{a.mention}”?</option>
                        {a.options.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.email}</option>)}
                      </select>
                    ))}
                  </span></li>
                )}
                {res.draft.location && <li><MapPin size={15} /><span>{res.draft.location}</span></li>}
                {res.draft.video && (
                  <li><Video size={15} /><input className="ws-input ai-video" placeholder="Paste the video meeting link (optional)" value={video} onChange={(e) => setVideo(e.target.value)} aria-label="Video meeting link" /></li>
                )}
              </ul>
              {res.conflicts.length > 0 && (
                <p className="ai-warn"><AlertTriangle size={14} /> Clashes with another event for {res.conflicts.map((c) => c.name).join(", ")}.</p>
              )}
              {res.notes.map((n) => <p key={n} className="ai-note">{n}</p>)}
              <div className="ai-actions">
                <button className="ws-btn primary" onClick={() => create(res.draft, res.match)} disabled={!!saving}><Check size={15} /> {saving ? "Creating…" : res.draft.attendees.length ? "Create and invite" : "Create"}</button>
                <button className="ws-btn" onClick={() => { onEdit(editorDraft({ ...res.draft, attendees: [...res.draft.attendees, ...extraPeople(res.match).map((p) => ({ userId: p.id, name: p.name, email: p.email }))] }, calendarId)); setRes(null); }}>Edit details</button>
                <button className="ws-btn ghost" onClick={() => setRes(null)}>Cancel</button>
              </div>
            </>
          )}

          {res.kind === "slots" && (
            <>
              <div className="ai-kicker"><CalendarClock size={13} /> Best times · {res.minutes} min{res.people.length ? ` with ${res.people.map((p) => p.name.split(" ")[0]).join(", ")}` : ""}</div>
              <h3>{res.title}</h3>
              {res.match.ambiguous.map((a) => (
                <select key={a.mention} className="ws-select ai-pick" value={pick[a.mention] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [a.mention]: e.target.value }))} aria-label={`Which ${a.mention}?`}>
                  <option value="">Which “{a.mention}”?</option>
                  {a.options.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.email}</option>)}
                </select>
              ))}
              <div className="ai-slots">
                {res.slots.map((s, i) => (
                  <div key={s.start} className={`ai-slot${i === 0 ? " best" : ""}`}>
                    <div>
                      <b>{new Date(s.start).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · {new Date(s.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – {new Date(s.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</b>
                      <small>{i === 0 && <span className="ai-tag">best</span>}{s.reason}</small>
                    </div>
                    <button className="ws-btn primary sm" onClick={() => book(res, s)} disabled={!!saving}>{saving === s.start ? "Booking…" : "Book"}</button>
                  </div>
                ))}
              </div>
              {res.notes.map((n) => <p key={n} className="ai-note">{n}</p>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
