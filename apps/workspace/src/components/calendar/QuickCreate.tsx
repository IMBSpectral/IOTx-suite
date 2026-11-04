"use client";
import { useState } from "react";
import { Clock, Plane, Target, X } from "lucide-react";
import { fromKey, zonedToDate } from "./types";
import type { Draft, EventType } from "./EventEditor";

/** The small "Add title" bubble after clicking or dragging on the grid; More options opens the full editor. */
export default function QuickCreate({ draft, busy, onSave, onMore, onClose }: { draft: Draft; busy: boolean; onSave: (d: Draft) => void; onMore: (d: Draft) => void; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const s = d.allDay ? fromKey(d.sDate) : zonedToDate(d.sDate, d.sTime, d.tz);
  const e = d.allDay ? fromKey(d.eDate) : zonedToDate(d.eDate, d.eTime, d.tz);
  const when = d.allDay
    ? `${s.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}${d.eDate !== d.sDate ? ` – ${e.toLocaleDateString([], { month: "long", day: "numeric" })}` : ""}`
    : `${s.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })} · ${s.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${e.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const type = (t: EventType) =>
    setD((x) => ({
      ...x, eventType: t, autoDecline: t !== "default",
      title: !x.title || ["Out of office", "Focus time"].includes(x.title) ? (t === "outOfOffice" ? "Out of office" : t === "focusTime" ? "Focus time" : "") : x.title,
      declineMessage: t === "outOfOffice" ? "I'm out of office and will reply when I'm back." : t === "focusTime" ? "I'm in focus time and will reply later." : "",
    }));
  return (
    <div className="ws-modal-scrim light" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <form className="ws-modal quick" role="dialog" aria-label="Quick add event" onSubmit={(ev) => { ev.preventDefault(); onSave(d); }}>
        <header>
          <input className="ws-input quick-title" autoFocus placeholder="Add title" value={d.title} onChange={(ev) => setD({ ...d, title: ev.target.value })} aria-label="Title" />
          <button type="button" className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="body">
          <div className="ws-seg ev-types" role="group" aria-label="Event type">
            <button type="button" aria-pressed={d.eventType === "default"} onClick={() => type("default")}><Clock size={13} /> Event</button>
            <button type="button" aria-pressed={d.eventType === "focusTime"} onClick={() => type("focusTime")}><Target size={13} /> Focus time</button>
            <button type="button" aria-pressed={d.eventType === "outOfOffice"} onClick={() => type("outOfOffice")}><Plane size={13} /> Out of office</button>
          </div>
          <p className="quick-when">{when}</p>
        </div>
        <footer>
          <button type="button" className="ws-btn ghost" onClick={() => onMore(d)}>More options</button>
          <button type="submit" className="ws-btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </footer>
      </form>
    </div>
  );
}
