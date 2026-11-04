"use client";
import { useEffect, useState } from "react";
import { Bell, CalendarDays, Clock, Copy, Download, Lock, Mail, MapPin, MessageSquare, Paperclip, Pencil, Plane, Repeat, Target, Trash2, Users, Video, Wand2, X } from "lucide-react";
import { api } from "@/lib/client";
import { dateKey, fmtRange, fmtTime, timeKey, type Cal, type Occ } from "./types";
import { describeRepeat } from "./repeat";
import { remName } from "./EventEditor";
import FlexibleSwitch from "@/components/meet/read/FlexibleSwitch";

const NAMES: Record<string, string> = { yes: "Going", no: "Not going", maybe: "Maybe", needs: "Awaiting reply" };
type File = { id: string; name: string; size: number; type: string; url: string };

export default function EventDetail({
  o, cal, meId, onClose, onEdit, onDelete, onRespond, onPrepare, onDuplicate, onChanged, flash,
}: {
  o: Occ;
  meId: string;
  cal?: Cal;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRespond: (r: "yes" | "no" | "maybe", extra?: { comment?: string; proposeStart?: string; proposeEnd?: string }) => void;
  /** Calendar AI: guests, related tasks and emails, and a briefing. */
  onPrepare?: () => void;
  onDuplicate?: () => void;
  onChanged?: () => void;
  flash?: (m: string) => void;
}) {
  // A Google invitation (someone else organizes it) is answered here too; the reply goes back to Google.
  const invited = o.attendees.some((a) => a.userId === meId) || !!o.googleOrganizer;
  const organizer = o.creatorId === meId && !o.googleOrganizer;
  const virtual = o.id.startsWith("plan:") || o.id.startsWith("bday:");
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState<null | { comment: string; propose: boolean; sDate: string; sTime: string; eTime: string }>(null);
  const [uploading, setUploading] = useState(false);
  const mine = o.attendees.find((a) => a.userId === meId);

  useEffect(() => {
    if (o.masked || virtual || o.readOnly) return;
    api<{ files: File[] }>(`/calendar/events/${o.id}/files`).then((r) => setFiles(r.files)).catch(() => {});
  }, [o.id, o.masked]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of [...list]) {
        const fd = new FormData();
        fd.append("file", f);
        const r = await fetch(`/workspace/api/calendar/events/${o.id}/files`, { method: "POST", body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "Upload failed");
        setFiles((x) => [...x, j.file]);
      }
    } catch (e) {
      flash?.((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const removeFile = async (f: File) => {
    try {
      await api(`/calendar/files/${f.id}`, { method: "DELETE" });
      setFiles((x) => x.filter((y) => y.id !== f.id));
    } catch (e) {
      flash?.((e as Error).message);
    }
  };
  const accept = async (email: string) => {
    try {
      await api(`/calendar/events/${o.id}/proposal`, { body: { email } });
      flash?.("New time accepted. Guests are told.");
      onChanged?.();
      onClose();
    } catch (e) {
      flash?.((e as Error).message);
    }
  };

  if (o.masked)
    return (
      <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="ws-modal" style={{ width: 400 }} role="dialog" aria-label="Busy">
          <header>
            <span className="ws-swatch" style={{ background: o.color, width: 14, height: 14 }} />
            <h3>Busy</h3>
            <button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </header>
          <div className="body">
            <div className="ev-meta">
              <div><Clock size={16} /><span>{fmtRange(o)}</span></div>
              {cal && <div><CalendarDays size={16} /><span>{cal.name}{cal.ownerName ? ` · ${cal.ownerName}` : ""}</span></div>}
              <div><Lock size={16} /><span className="ws-muted">Only free/busy is shared for this calendar or event.</span></div>
            </div>
          </div>
        </div>
      </div>
    );

  const typeBadge = o.eventType === "outOfOffice" ? <span className="ev-badge ooo"><Plane size={12} /> Out of office</span> : o.eventType === "focusTime" ? <span className="ev-badge focus"><Target size={12} /> Focus time</span> : null;
  const s = new Date(o.start), e = new Date(o.end);
  return (
    <div className="ws-modal-scrim" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="ws-modal" role="dialog" aria-label={o.title}>
        <header>
          <span className="ws-swatch" style={{ background: o.color, width: 14, height: 14 }} />
          <h3>{o.title}</h3>
          {onPrepare && !o.allDay && o.eventType === "default" && (
            <button className="ws-btn sm ai-prep-btn" onClick={onPrepare} title="Prepare for this meeting"><Wand2 size={14} /> Prepare</button>
          )}
          {o.canEdit && <button className="ix-iconbtn" onClick={onEdit} aria-label="Edit event" title="Edit (e)"><Pencil size={17} /></button>}
          {onDuplicate && <button className="ix-iconbtn" onClick={onDuplicate} aria-label="Duplicate event" title="Duplicate"><Copy size={16} /></button>}
          {o.canEdit && <button className="ix-iconbtn" onClick={onDelete} aria-label="Delete event" title="Delete"><Trash2 size={17} /></button>}
          <button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="body">
          <div className="ev-meta">
            {typeBadge && <div>{typeBadge}{o.autoDecline && <span className="ws-muted" style={{ fontSize: 12 }}>Declines new invitations{o.declineMessage ? `: “${o.declineMessage}”` : ""}</span>}</div>}
            <div><Clock size={16} /><span>{fmtRange(o)}{!o.allDay && o.tz && o.tz !== Intl.DateTimeFormat().resolvedOptions().timeZone ? <small className="ws-muted"> · {fmtTime(s, o.tz)} – {fmtTime(e, o.tz)} {o.tz.replace(/_/g, " ")}</small> : null}</span></div>
            {o.rrule && <div><Repeat size={16} /><span>{describeRepeat(o.rrule, dateKey(s))}</span></div>}
            {o.conferenceUrl && (
              <div>
                <Video size={16} />
                <a className="join" href={o.conferenceUrl} target="_blank" rel="noreferrer">
                  Join {/\/workspace\/meet\//.test(o.conferenceUrl) ? "IOTx Meet" : /meet\.google/.test(o.conferenceUrl) ? "Google Meet" : /zoom\.us/.test(o.conferenceUrl) ? "Zoom" : /teams\./.test(o.conferenceUrl) ? "Teams" : "call"}
                </a>
              </div>
            )}
            {o.location && <div><MapPin size={16} /><span>{o.location}</span></div>}
            {o.googleOrganizer && <div><Users size={16} /><span>Organized by {o.googleOrganizer} <small className="ws-muted">· in Google Calendar</small></span></div>}
            {organizer && !virtual && !o.allDay && !o.rrule && o.eventType === "default" && o.attendees.length > 0 && <FlexibleSwitch eventId={o.id} />}
            {cal && <div><CalendarDays size={16} /><span>{cal.name}{cal.ownerName && !cal.mine && cal.kind === "personal" ? ` · ${cal.ownerName}` : ""}{o.google ? " · synced with Google" : ""}{o.transparency === "free" ? " · shown as free" : ""}{o.visibility === "private" ? " · private" : ""}</span></div>}
            {(o.reminders.length > 0 || (o.emailReminders?.length ?? 0) > 0) && (
              <div><Bell size={16} /><span>{[...o.reminders.map((m) => remName(m)), ...(o.emailReminders ?? []).map((m) => `Email ${remName(m)}`)].join(", ")}</span></div>
            )}
            {o.attendees.length > 0 && (
              <div>
                <Users size={16} />
                <div style={{ flex: 1 }}>
                  <div className="ws-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                    {o.attendees.length} {o.attendees.length === 1 ? "guest" : "guests"} · {o.attendees.filter((a) => a.response === "yes").length} yes{o.attendees.some((a) => a.response === "no") ? `, ${o.attendees.filter((a) => a.response === "no").length} no` : ""}{o.attendees.some((a) => a.response === "needs") ? `, ${o.attendees.filter((a) => a.response === "needs").length} awaiting` : ""}
                  </div>
                  {o.attendees.map((a) => (
                    <div key={a.email} className="att">
                      <span>{a.name || a.email}</span>
                      {!a.userId && <small>guest</small>}
                      {a.optional && <small>optional</small>}
                      <small className={`r-${a.response}`}>{NAMES[a.response] ?? a.response}</small>
                      {a.comment && <div className="att-note"><MessageSquare size={11} /> {a.comment}</div>}
                      {a.proposedStart && (
                        <div className="att-note">
                          Proposed {new Date(a.proposedStart).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} {fmtTime(new Date(a.proposedStart))}{a.proposedEnd ? ` – ${fmtTime(new Date(a.proposedEnd))}` : ""}
                          {organizer && o.canEdit && <button className="ws-link" style={{ marginLeft: 6 }} onClick={() => accept(a.email)}>Accept</button>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {o.description && <div style={{ whiteSpace: "pre-wrap", display: "block", paddingTop: 4 }}>{o.description}</div>}
            {(files.length > 0 || o.canEdit) && (
              <div>
                <Paperclip size={16} />
                <div style={{ flex: 1 }}>
                  {files.map((f) => (
                    <div key={f.id} className="att">
                      <a href={`/workspace/api/calendar/files/${f.id}`} target="_blank" rel="noreferrer">{f.name}</a>
                      <small>{f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1e3))} KB`}</small>
                      <a className="ix-iconbtn" style={{ width: 24, height: 24 }} href={`/workspace/api/calendar/files/${f.id}?download=1`} aria-label={`Download ${f.name}`}><Download size={13} /></a>
                      {o.canEdit && <button className="ix-iconbtn" style={{ width: 24, height: 24 }} onClick={() => removeFile(f)} aria-label={`Remove ${f.name}`}><X size={13} /></button>}
                    </div>
                  ))}
                  {o.canEdit && (
                    <label className="ws-link" style={{ cursor: "pointer" }}>
                      {uploading ? "Uploading…" : "Attach a file"}
                      <input type="file" multiple hidden onChange={(ev) => { void upload(ev.target.files); ev.target.value = ""; }} />
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>
          {note && (
            <div className="ev-note">
              <textarea className="ws-textarea" placeholder="Add a note for the organizer" value={note.comment} onChange={(ev) => setNote({ ...note, comment: ev.target.value })} aria-label="Note" style={{ minHeight: 60 }} />
              <label className="ws-row" style={{ gap: 6, fontSize: 13, margin: "6px 0" }}>
                <input type="checkbox" checked={note.propose} onChange={(ev) => setNote({ ...note, propose: ev.target.checked })} /> Propose a new time
              </label>
              {note.propose && (
                <div className="ws-row">
                  <input className="ws-input" type="date" style={{ width: 150 }} value={note.sDate} onChange={(ev) => setNote({ ...note, sDate: ev.target.value })} aria-label="Proposed date" />
                  <input className="ws-input" type="time" step={900} style={{ width: 120 }} value={note.sTime} onChange={(ev) => setNote({ ...note, sTime: ev.target.value })} aria-label="Proposed start" />
                  <span className="ws-muted">to</span>
                  <input className="ws-input" type="time" step={900} style={{ width: 120 }} value={note.eTime} onChange={(ev) => setNote({ ...note, eTime: ev.target.value })} aria-label="Proposed end" />
                </div>
              )}
            </div>
          )}
        </div>
        {invited && !organizer && !o.readOnly && (
          <footer style={{ justifyContent: "flex-start" }}>
            <div className="rsvp">
              <span className="ws-muted">Going?</span>
              {(["yes", "no", "maybe"] as const).map((r) => (
                <button key={r} className={`ws-btn${o.myResponse === r ? " on" : ""}`} aria-pressed={o.myResponse === r}
                  onClick={() => {
                    if (!note) return onRespond(r);
                    const extra = { comment: note.comment, ...(note.propose ? { proposeStart: new Date(`${note.sDate}T${note.sTime}`).toISOString(), proposeEnd: new Date(`${note.sDate}T${note.eTime}`).toISOString() } : {}) };
                    onRespond(r, extra);
                    setNote(null);
                  }}>
                  {r === "yes" ? "Yes" : r === "no" ? "No" : "Maybe"}
                </button>
              ))}
              {!note && !o.googleOrganizer && (
                <button className="ws-link" onClick={() => setNote({ comment: mine?.comment ?? "", propose: false, sDate: dateKey(s), sTime: timeKey(s), eTime: timeKey(e) })}>
                  <Mail size={13} /> Note or new time
                </button>
              )}
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

export type Scope = "this" | "following" | "all";
export function ScopeAsk({ verb, onPick, onClose }: { verb: string; onPick: (s: Scope) => void; onClose: () => void }) {
  const [s, setS] = useState<Scope>("this");
  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-modal" style={{ width: 380 }} role="dialog" aria-label={`${verb} repeating event`}>
        <header><h3>{verb} repeating event</h3></header>
        <div className="body ev-scope">
          {([["this", "This event"], ["following", "This and following events"], ["all", "All events"]] as const).map(([k, l]) => (
            <label key={k}><input type="radio" name="scope" checked={s === k} onChange={() => setS(k)} autoFocus={k === "this"} /> {l}</label>
          ))}
        </div>
        <footer>
          <button className="ws-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ws-btn primary" onClick={() => onPick(s)}>OK</button>
        </footer>
      </div>
    </div>
  );
}
