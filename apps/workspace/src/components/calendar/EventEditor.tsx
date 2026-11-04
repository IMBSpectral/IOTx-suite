"use client";
import { useMemo, useState } from "react";
import { Bell, Clock, Globe, Mail, Paperclip, Plane, Target, UserCheck, X } from "lucide-react";
import { addDays, allDayRange, COLORS, dateIn, dateKey, fromKey, localTz, timeKey, WEEKDAYS, zonedToDate, zones, type Cal, type Occ, type Person } from "./types";
import { blankRepeat, buildRepeat, describeRepeat, parseRepeat, presets, type Repeat } from "./repeat";

export type Guest = { userId?: string; email: string; name: string; optional?: boolean };
export type EventType = "default" | "focusTime" | "outOfOffice";
export type Draft = {
  id?: string;
  occ?: string | null;
  isSeries: boolean;
  title: string;
  calendarId: string;
  allDay: boolean;
  sDate: string;
  sTime: string;
  eDate: string;
  eTime: string;
  /** The zone the times above are in. */
  tz: string;
  rrule: string | null;
  location: string;
  conferenceUrl: string;
  /** "Add video meeting": an IOTx Meet link is made when the event is saved. */
  videoMeeting?: boolean;
  description: string;
  reminders: number[];
  emailReminders: number[];
  color: string | null;
  guests: Guest[];
  eventType: EventType;
  visibility: "default" | "public" | "private";
  transparency: "busy" | "free";
  autoDecline: boolean;
  declineMessage: string;
  guestsCanModify: boolean;
  guestsCanInvite: boolean;
  guestsSeeList: boolean;
  /** Files picked before the event exists: uploaded right after it is created. */
  files: File[];
};

export function draftNew(start: Date, end: Date, allDay: boolean, calendarId: string, opts: { reminders?: number[]; eventType?: EventType } = {}): Draft {
  const type = opts.eventType ?? "default";
  return {
    isSeries: false, title: type === "outOfOffice" ? "Out of office" : type === "focusTime" ? "Focus time" : "", calendarId, allDay,
    sDate: dateKey(start), sTime: timeKey(start),
    eDate: dateKey(allDay ? addDays(end, -1) : end), eTime: timeKey(end), tz: localTz(),
    rrule: null, location: "", conferenceUrl: "", description: "", reminders: opts.reminders ?? [10], emailReminders: [], color: null, guests: [],
    eventType: type, visibility: "default", transparency: "busy", autoDecline: type !== "default", declineMessage: type === "outOfOffice" ? "I'm out of office and will reply when I'm back." : "",
    guestsCanModify: false, guestsCanInvite: true, guestsSeeList: true, files: [],
  };
}

export function draftFrom(o: Occ, ownColor: string | null): Draft {
  // Times are shown in the event's own zone, so a 10:00 meeting in Kolkata reads 10:00.
  const tz = o.tz || localTz();
  let sDate: string, sTime: string, eDate: string, eTime: string;
  if (o.allDay) {
    const r = allDayRange(o);
    sDate = dateKey(r.start); eDate = dateKey(addDays(r.end, -1)); sTime = "09:00"; eTime = "10:00";
  } else {
    const s = dateIn(new Date(o.start), tz), e = dateIn(new Date(o.end), tz);
    sDate = s.date; sTime = s.time; eDate = e.date; eTime = e.time;
  }
  return {
    id: o.id, occ: o.occ, isSeries: !!o.rrule, title: o.title, calendarId: o.calendarId, allDay: o.allDay,
    sDate, sTime, eDate, eTime, tz, rrule: o.rrule,
    location: o.location, conferenceUrl: o.conferenceUrl ?? "", description: o.description,
    reminders: o.reminders, emailReminders: o.emailReminders ?? [], color: ownColor,
    guests: o.attendees.map((a) => ({ userId: a.userId ?? undefined, email: a.email, name: a.name, optional: !!a.optional })),
    eventType: (o.eventType as EventType) || "default", visibility: (o.visibility as Draft["visibility"]) || "default", transparency: o.transparency === "free" ? "free" : "busy",
    autoDecline: !!o.autoDecline, declineMessage: o.declineMessage ?? "",
    guestsCanModify: !!o.guestsCanModify, guestsCanInvite: o.guestsCanInvite !== false, guestsSeeList: o.guestsSeeList !== false, files: [],
  };
}

/** A copy of an event as a new one ("Duplicate"). */
export function draftCopy(o: Occ, ownColor: string | null): Draft {
  const d = draftFrom(o, ownColor);
  return { ...d, id: undefined, occ: null, isSeries: false, title: `${d.title}`, guests: d.guests };
}

export function draftToBody(d: Draft) {
  let start: string, end: string;
  if (d.allDay) {
    start = d.sDate;
    end = dateKey(addDays(fromKey(d.eDate < d.sDate ? d.sDate : d.eDate), 1));
  } else {
    start = zonedToDate(d.sDate, d.sTime, d.tz).toISOString();
    end = zonedToDate(d.eDate, d.eTime, d.tz).toISOString();
  }
  const simple = d.eventType === "default";
  return {
    title: d.title.trim() || (d.eventType === "outOfOffice" ? "Out of office" : d.eventType === "focusTime" ? "Focus time" : "(No title)"),
    calendarId: d.calendarId,
    allDay: d.allDay,
    start, end,
    tz: d.tz,
    rrule: d.rrule,
    location: simple ? d.location : "",
    conferenceUrl: simple ? d.conferenceUrl.trim() || null : null,
    ...(simple && d.videoMeeting ? { videoMeeting: true } : {}),
    description: d.description,
    reminders: d.reminders,
    emailReminders: d.emailReminders,
    color: d.color,
    eventType: d.eventType,
    visibility: d.visibility,
    transparency: d.eventType === "default" ? d.transparency : "busy",
    autoDecline: d.eventType !== "default" && d.autoDecline,
    declineMessage: d.eventType !== "default" ? d.declineMessage : "",
    guestsCanModify: d.guestsCanModify,
    guestsCanInvite: d.guestsCanInvite,
    guestsSeeList: d.guestsSeeList,
    attendees: simple ? d.guests.map((g) => (g.userId ? { userId: g.userId, optional: !!g.optional } : { email: g.email, name: g.name, optional: !!g.optional })) : [],
  };
}

export const REMINDERS: [number, string][] = [[0, "At start"], [5, "5 minutes before"], [10, "10 minutes before"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [120, "2 hours before"], [1440, "1 day before"], [2880, "2 days before"], [10080, "1 week before"]];
export const remName = (m: number) => REMINDERS.find((r) => r[0] === m)?.[1] ?? (m % 1440 === 0 ? `${m / 1440} days before` : m % 60 === 0 ? `${m / 60} hours before` : `${m} minutes before`);

const TYPES: { id: EventType; label: string; icon: React.ReactNode }[] = [
  { id: "default", label: "Event", icon: <Clock size={14} /> },
  { id: "focusTime", label: "Focus time", icon: <Target size={14} /> },
  { id: "outOfOffice", label: "Out of office", icon: <Plane size={14} /> },
];

export default function EventEditor({
  draft, calendars, people, meId, onSave, onClose, onFindTime, busy,
}: {
  draft: Draft;
  calendars: Cal[];
  people: Person[];
  meId: string;
  busy: boolean;
  onSave: (d: Draft) => void;
  onClose: () => void;
  onFindTime: (d: Draft) => void;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [q, setQ] = useState("");
  const [showTz, setShowTz] = useState(draft.tz !== localTz());
  const [custom, setCustom] = useState<Repeat | null>(null);
  const [remKind, setRemKind] = useState<"popup" | "email">("popup");
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const zoneList = useMemo(() => zones(), []);
  const writable = calendars.filter((c) => c.kind !== "subscribed" && (!c.access || ["owner", "manage", "edit"].includes(c.access)));
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return people.filter((p) => p.id !== meId && !d.guests.some((g) => g.email.toLowerCase() === p.email.toLowerCase()) && (p.name.toLowerCase().includes(s) || p.email.toLowerCase().includes(s))).slice(0, 6);
  }, [q, people, d.guests, meId]);
  const addEmail = () => {
    const e = q.trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !d.guests.some((g) => g.email.toLowerCase() === e.toLowerCase())) {
      const p = people.find((x) => x.email.toLowerCase() === e.toLowerCase());
      set("guests", [...d.guests, p ? { userId: p.id, email: p.email, name: p.name } : { email: e, name: "" }]);
      setQ("");
    }
  };
  const kind = d.eventType;
  const repeatOptions = presets(d.sDate);
  const isPreset = repeatOptions.some((p) => p.rule === d.rrule);

  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="ws-modal ev-editor"
        role="dialog"
        aria-label={d.id ? "Edit event" : "New event"}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(d);
        }}
      >
        <header>
          <h3>{d.id ? "Edit event" : "New event"}</h3>
          <button type="button" className="ix-iconbtn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="body">
          <div className="ws-field">
            <input className="ws-input" style={{ fontSize: 17, fontWeight: 600 }} autoFocus placeholder="Add title" value={d.title} onChange={(e) => set("title", e.target.value)} aria-label="Title" />
          </div>
          {!d.id && (
            <div className="ws-seg ev-types" role="group" aria-label="Event type">
              {TYPES.map((t) => (
                <button type="button" key={t.id} aria-pressed={kind === t.id}
                  onClick={() => setD((x) => ({
                    ...x, eventType: t.id, autoDecline: t.id !== "default",
                    title: !x.title || ["Out of office", "Focus time"].includes(x.title) ? (t.id === "outOfOffice" ? "Out of office" : t.id === "focusTime" ? "Focus time" : "") : x.title,
                    declineMessage: x.declineMessage || (t.id === "outOfOffice" ? "I'm out of office and will reply when I'm back." : t.id === "focusTime" ? "I'm in focus time and will reply later." : ""),
                  }))}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          )}
          <div className="ws-field ws-row">
            <input className="ws-input" style={{ width: 150 }} type="date" value={d.sDate} aria-label="Start date"
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const shift = Math.round((fromKey(v).getTime() - fromKey(d.sDate).getTime()) / 86_400_000);
                setD((x) => ({ ...x, sDate: v, eDate: dateKey(addDays(fromKey(x.eDate), shift)) }));
              }} />
            {!d.allDay && <input className="ws-input" style={{ width: 120 }} type="time" step={900} value={d.sTime} aria-label="Start time"
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                // Keep the length when the start moves (as Google does).
                const len = zonedToDate(d.eDate, d.eTime, "UTC").getTime() - zonedToDate(d.sDate, d.sTime, "UTC").getTime();
                const ne = new Date(zonedToDate(d.sDate, v, "UTC").getTime() + Math.max(len, 0));
                setD((x) => ({ ...x, sTime: v, eDate: ne.toISOString().slice(0, 10), eTime: ne.toISOString().slice(11, 16) }));
              }} />}
            <span className="ws-muted">to</span>
            <input className="ws-input" style={{ width: 150 }} type="date" value={d.eDate} onChange={(e) => set("eDate", e.target.value)} aria-label="End date" />
            {!d.allDay && <input className="ws-input" style={{ width: 120 }} type="time" step={900} value={d.eTime} onChange={(e) => set("eTime", e.target.value)} aria-label="End time" />}
          </div>
          <div className="ws-field ws-row" style={{ gap: 14 }}>
            <label className="ws-row" style={{ gap: 6 }}>
              <input type="checkbox" checked={d.allDay} onChange={(e) => set("allDay", e.target.checked)} /> All day
            </label>
            {!d.allDay && (
              <button type="button" className="ws-link" onClick={() => setShowTz((v) => !v)}><Globe size={13} /> {showTz ? d.tz.replace(/_/g, " ") : "Time zone"}</button>
            )}
            <select className="ws-select" style={{ width: "auto", flex: 1, minWidth: 170 }} aria-label="Repeat" value={isPreset ? d.rrule ?? "" : "__custom"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__open") setCustom(d.rrule ? parseRepeat(d.rrule, d.sDate) : { ...blankRepeat(d.sDate), freq: "WEEKLY" });
                else if (v !== "__custom") set("rrule", v || null);
              }}>
              {repeatOptions.map((p) => <option key={p.label} value={p.rule ?? ""}>{p.label}</option>)}
              {!isPreset && <option value="__custom">{describeRepeat(d.rrule, d.sDate)}</option>}
              <option value="__open">Custom…</option>
            </select>
          </div>
          {showTz && !d.allDay && (
            <div className="ws-field">
              <select className="ws-select" aria-label="Event time zone" value={d.tz} onChange={(e) => set("tz", e.target.value)}>
                {[...new Set([d.tz, ...zoneList])].map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
              </select>
            </div>
          )}
          {custom && <CustomRepeat r={custom} date={d.sDate} onCancel={() => setCustom(null)} onDone={(r) => { set("rrule", buildRepeat(r, d.sDate)); setCustom(null); }} />}

          {kind !== "default" && (
            <div className="ws-field ev-auto">
              <label className="ws-row" style={{ gap: 6 }}>
                <input type="checkbox" checked={d.autoDecline} onChange={(e) => set("autoDecline", e.target.checked)} />
                Automatically decline new and existing meetings
              </label>
              {d.autoDecline && (
                <input className="ws-input" style={{ marginTop: 6 }} placeholder="Message" value={d.declineMessage} onChange={(e) => set("declineMessage", e.target.value)} aria-label="Decline message" />
              )}
              <p className="ws-muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
                {kind === "outOfOffice" ? "People who invite you see that you're away." : "Notifications are quieter while focus time is on."}
              </p>
            </div>
          )}

          {kind === "default" && (
            <div className="ws-field">
              <label className="ws-label">Guests</label>
              <div className="ws-row" style={{ marginBottom: 6 }}>
                {d.guests.map((g) => (
                  <span key={g.email} className={`ws-chip${g.optional ? " optional" : ""}`}>
                    {g.name || g.email}
                    {!g.userId && <small className="ws-muted">guest</small>}
                    <button type="button" title={g.optional ? "Mark as required" : "Mark as optional"} aria-label={g.optional ? `Mark ${g.email} required` : `Mark ${g.email} optional`}
                      onClick={() => set("guests", d.guests.map((x) => (x.email === g.email ? { ...x, optional: !x.optional } : x)))}>
                      <UserCheck size={12} style={{ opacity: g.optional ? 0.4 : 1 }} />
                    </button>
                    <button type="button" aria-label={`Remove ${g.email}`} onClick={() => set("guests", d.guests.filter((x) => x.email !== g.email))}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ position: "relative" }}>
                <input className="ws-input" placeholder="Add people or an email address" value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (matches[0]) {
                        set("guests", [...d.guests, { userId: matches[0].id, email: matches[0].email, name: matches[0].name }]);
                        setQ("");
                      } else addEmail();
                    }
                  }} aria-label="Add guests" />
                {(matches.length > 0 || /@.+\./.test(q)) && (
                  <div className="suggest">
                    {matches.map((p) => (
                      <button type="button" key={p.id} onClick={() => { set("guests", [...d.guests, { userId: p.id, email: p.email, name: p.name }]); setQ(""); }}>
                        {p.name} <span className="ws-muted">{p.email}</span>
                      </button>
                    ))}
                    {matches.length === 0 && <button type="button" onClick={addEmail}>Invite {q.trim()} as a guest (they get an email)</button>}
                  </div>
                )}
              </div>
              {d.guests.length > 0 && (
                <div className="ev-perms">
                  <span className="ws-muted">Guests can</span>
                  <label><input type="checkbox" checked={d.guestsCanModify} onChange={(e) => set("guestsCanModify", e.target.checked)} /> modify event</label>
                  <label><input type="checkbox" checked={d.guestsCanInvite} onChange={(e) => set("guestsCanInvite", e.target.checked)} /> invite others</label>
                  <label><input type="checkbox" checked={d.guestsSeeList} onChange={(e) => set("guestsSeeList", e.target.checked)} /> see guest list</label>
                </div>
              )}
              {!d.allDay && (
                <button type="button" className="ws-link" style={{ marginTop: 6 }} onClick={() => onFindTime(d)}>
                  Find a time with these people
                </button>
              )}
            </div>
          )}
          {kind === "default" && (
            <div className="ws-field ws-row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label className="ws-label" htmlFor="ev-loc">Location</label>
                <input id="ev-loc" className="ws-input" value={d.location} onChange={(e) => set("location", e.target.value)} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label className="ws-label" htmlFor="ev-conf">Video call link</label>
                {/\/workspace\/meet\//.test(d.conferenceUrl) ? (
                  <p style={{ margin: "6px 0 0", fontSize: 13 }}>IOTx Meet link added. <a href={d.conferenceUrl} target="_blank" rel="noreferrer">Open</a></p>
                ) : (
                  <>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, margin: "2px 0 6px" }}>
                      <input type="checkbox" checked={!!d.videoMeeting} onChange={(e) => set("videoMeeting", e.target.checked)} /> Add video meeting
                    </label>
                    {d.videoMeeting ? (
                      <p style={{ margin: 0, fontSize: 12, color: "var(--ix-muted)" }}>An IOTx Meet link is added when you save.</p>
                    ) : (
                      <input id="ev-conf" className="ws-input" placeholder="https://meet.google.com/…" value={d.conferenceUrl} onChange={(e) => set("conferenceUrl", e.target.value)} />
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          <div className="ws-field ws-row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 150 }}>
              <label className="ws-label" htmlFor="ev-cal">Calendar</label>
              <select id="ev-cal" className="ws-select" value={d.calendarId} onChange={(e) => set("calendarId", e.target.value)}>
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.ownerName && !c.mine && c.kind === "personal" ? ` (${c.ownerName})` : ""}</option>
                ))}
              </select>
            </div>
            {kind === "default" && (
              <div style={{ flex: 1, minWidth: 120 }}>
                <label className="ws-label" htmlFor="ev-busy">Show as</label>
                <select id="ev-busy" className="ws-select" value={d.transparency} onChange={(e) => set("transparency", e.target.value as Draft["transparency"])}>
                  <option value="busy">Busy</option>
                  <option value="free">Free</option>
                </select>
              </div>
            )}
            <div style={{ flex: 1, minWidth: 150 }}>
              <label className="ws-label" htmlFor="ev-vis">Visibility</label>
              <select id="ev-vis" className="ws-select" value={d.visibility} onChange={(e) => set("visibility", e.target.value as Draft["visibility"])}>
                <option value="default">Default visibility</option>
                <option value="public">Public</option>
                <option value="private">Private (others see “busy”)</option>
              </select>
            </div>
          </div>
          <div className="ws-field">
            <label className="ws-label" htmlFor="ev-rem">Notifications</label>
            <div className="ws-row">
              {d.reminders.map((m) => (
                <span key={`p${m}`} className="ws-chip">
                  <Bell size={12} /> {remName(m)}
                  <button type="button" aria-label={`Remove reminder ${remName(m)}`} onClick={() => set("reminders", d.reminders.filter((x) => x !== m))}><X size={12} /></button>
                </span>
              ))}
              {d.emailReminders.map((m) => (
                <span key={`e${m}`} className="ws-chip">
                  <Mail size={12} /> Email {remName(m)}
                  <button type="button" aria-label={`Remove email reminder ${remName(m)}`} onClick={() => set("emailReminders", d.emailReminders.filter((x) => x !== m))}><X size={12} /></button>
                </span>
              ))}
              <select className="ws-select" style={{ width: "auto" }} aria-label="Reminder kind" value={remKind} onChange={(e) => setRemKind(e.target.value as "popup" | "email")}>
                <option value="popup">Notification</option>
                <option value="email">Email</option>
              </select>
              <select id="ev-rem" className="ws-select" style={{ width: "auto" }} value=""
                onChange={(e) => {
                  if (e.target.value === "") return;
                  const k = remKind === "email" ? "emailReminders" : "reminders";
                  set(k, [...new Set([...d[k], Number(e.target.value)])].sort((a, b) => a - b).slice(0, 5));
                }}>
                <option value="">Add…</option>
                {REMINDERS.filter((r) => !(remKind === "email" ? d.emailReminders : d.reminders).includes(r[0])).map((r) => (
                  <option key={r[0]} value={r[0]}>{r[1]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="ws-field">
            <label className="ws-label">Colour</label>
            <div className="colors">
              <button type="button" aria-pressed={!d.color} aria-label="Calendar colour" title="Calendar colour" style={{ background: "conic-gradient(#4f46e5,#16a34a,#dc2626,#4f46e5)" }} onClick={() => set("color", null)} />
              {COLORS.map((c) => (
                <button type="button" key={c} aria-pressed={d.color === c} aria-label={c} style={{ background: c }} onClick={() => set("color", c)} />
              ))}
            </div>
          </div>
          <div className="ws-field">
            <label className="ws-label" htmlFor="ev-desc">Description</label>
            <textarea id="ev-desc" className="ws-textarea" value={d.description} onChange={(e) => set("description", e.target.value)} />
          </div>
          {!d.id && kind === "default" && (
            <div className="ws-field">
              <label className="ws-btn sm" style={{ cursor: "pointer" }}>
                <Paperclip size={13} /> Attach files
                <input type="file" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; set("files", [...d.files, ...f].slice(0, 20)); }} />
              </label>
              {d.files.map((f, i) => (
                <span key={i} className="ws-chip" style={{ marginLeft: 6 }}>
                  {f.name}
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => set("files", d.files.filter((_, j) => j !== i))}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="ws-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="ws-btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </footer>
      </form>
    </div>
  );
}

/** Google's "Custom recurrence": every N days/weeks/months/years, which days, and when it ends. */
function CustomRepeat({ r: init, date, onDone, onCancel }: { r: Repeat; date: string; onDone: (r: Repeat) => void; onCancel: () => void }) {
  const [r, setR] = useState<Repeat>({ ...init, freq: init.freq || "WEEKLY" });
  const day = fromKey(date);
  const nth = Math.ceil(day.getDate() / 7);
  return (
    <div className="ev-custom" role="group" aria-label="Custom repeat">
      <div className="ws-row">
        <span>Repeat every</span>
        <input className="ws-input" type="number" min={1} max={99} style={{ width: 64 }} value={r.interval} onChange={(e) => setR({ ...r, interval: Math.max(1, Number(e.target.value) || 1) })} aria-label="Interval" />
        <select className="ws-select" style={{ width: "auto" }} value={r.freq} onChange={(e) => setR({ ...r, freq: e.target.value as Repeat["freq"] })} aria-label="Unit">
          <option value="DAILY">{r.interval > 1 ? "days" : "day"}</option>
          <option value="WEEKLY">{r.interval > 1 ? "weeks" : "week"}</option>
          <option value="MONTHLY">{r.interval > 1 ? "months" : "month"}</option>
          <option value="YEARLY">{r.interval > 1 ? "years" : "year"}</option>
        </select>
      </div>
      {r.freq === "WEEKLY" && (
        <div className="daypick" style={{ margin: "10px 0 0" }}>
          {WEEKDAYS.map(([code, label]) => (
            <button type="button" key={code} aria-pressed={r.byday.includes(code)} aria-label={code}
              onClick={() => setR({ ...r, byday: r.byday.includes(code) ? r.byday.filter((x) => x !== code) : [...r.byday, code] })}>
              {label}
            </button>
          ))}
        </div>
      )}
      {r.freq === "MONTHLY" && (
        <select className="ws-select" style={{ marginTop: 10 }} value={r.monthMode} onChange={(e) => setR({ ...r, monthMode: e.target.value as Repeat["monthMode"] })} aria-label="Monthly on">
          <option value="date">Monthly on day {day.getDate()}</option>
          <option value="nth">Monthly on the {nth >= 5 ? "last" : ["", "first", "second", "third", "fourth"][nth]} {day.toLocaleDateString([], { weekday: "long" })}</option>
        </select>
      )}
      <div className="ev-ends">
        <span className="ws-label">Ends</span>
        <label><input type="radio" name="ends" checked={r.ends === "never"} onChange={() => setR({ ...r, ends: "never" })} /> Never</label>
        <label><input type="radio" name="ends" checked={r.ends === "until"} onChange={() => setR({ ...r, ends: "until", until: r.until || dateKey(addDays(day, 90)) })} /> On
          <input className="ws-input" type="date" style={{ width: 150 }} value={r.until} disabled={r.ends !== "until"} onChange={(e) => setR({ ...r, until: e.target.value })} aria-label="Ends on" /></label>
        <label><input type="radio" name="ends" checked={r.ends === "count"} onChange={() => setR({ ...r, ends: "count" })} /> After
          <input className="ws-input" type="number" min={1} max={999} style={{ width: 70 }} value={r.count} disabled={r.ends !== "count"} onChange={(e) => setR({ ...r, count: Number(e.target.value) || 1 })} aria-label="Occurrences" /> occurrences</label>
      </div>
      <div className="ws-row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
        <span className="ws-muted" style={{ flex: 1, fontSize: 12 }}>{describeRepeat(buildRepeat(r, date), date)}</span>
        <button type="button" className="ws-btn sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="ws-btn sm primary" onClick={() => onDone(r)}>Done</button>
      </div>
    </div>
  );
}
