"use client";
import { useEffect, useRef, useState } from "react";
import { Building2, House, MapPin, Plus } from "lucide-react";
import { DAY_NAMES } from "./types";

/** Working location for a day: from the weekly pattern (Settings → Working hours) or set for that date only. */
export type WorkLoc = { label: string; day: boolean } | null;

export const locKind = (label: string) => (/^home$/i.test(label) ? "home" : /^office$/i.test(label) ? "office" : "other");

/** The small strip under a day's date in the week / day views; click to change it. */
export default function WorkStrip({ day, value, canEdit, onSet }: { day: Date; value: WorkLoc; canEdit: boolean; onSet: (label: string | null, weekly: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [weekly, setWeekly] = useState(false);
  const [place, setPlace] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const kind = value ? locKind(value.label) : null;
  const Icon = kind === "home" ? House : kind === "office" ? Building2 : kind ? MapPin : Plus;
  const pick = (label: string | null) => {
    onSet(label, weekly);
    setOpen(false);
    setPlace("");
  };
  const dayName = DAY_NAMES[day.getDay()];
  return (
    <div className="wl" ref={box}>
      <button
        type="button"
        className={`wl-strip${value ? ` ${kind}` : " empty"}`}
        disabled={!canEdit}
        onClick={() => { setWeekly(!value?.day && !!value); setPlace(value && kind === "other" ? value.label : ""); setOpen((o) => !o); }}
        aria-label={value ? `Working location: ${value.label}. Change` : "Set working location"}
        title={value ? `${value.label}${value.day ? " (this day)" : ` (every ${dayName})`}` : "Set working location"}
      >
        <Icon size={11} aria-hidden /> <span>{value ? value.label : "Location"}</span>
      </button>
      {open && (
        <div className="ix-pop wl-pop" role="dialog" aria-label={`Working location, ${day.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })}`}>
          <div className="wl-scope" role="radiogroup" aria-label="Applies to">
            <label><input type="radio" name="wl-scope" checked={!weekly} onChange={() => setWeekly(false)} /> Only {day.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</label>
            <label><input type="radio" name="wl-scope" checked={weekly} onChange={() => setWeekly(true)} /> Every {dayName}</label>
          </div>
          <button type="button" className="wl-opt" aria-pressed={kind === "home"} onClick={() => pick("Home")}><House size={14} /> Home</button>
          <button type="button" className="wl-opt" aria-pressed={kind === "office"} onClick={() => pick("Office")}><Building2 size={14} /> Office</button>
          <form className="wl-place" onSubmit={(e) => { e.preventDefault(); if (place.trim()) pick(place.trim().slice(0, 60)); }}>
            <MapPin size={14} aria-hidden />
            <input className="ws-input" placeholder="Another place, e.g. Client site" value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Another place" maxLength={60} />
            <button className="ws-btn sm" disabled={!place.trim()}>Set</button>
          </form>
          {value && (weekly || value.day) && (
            <button type="button" className="ws-link wl-clear" onClick={() => pick(null)}>
              {weekly ? `Clear for every ${dayName}` : "Use the weekly location"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
