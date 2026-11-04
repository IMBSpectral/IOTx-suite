"use client";
import { useEffect, useRef, useState } from "react";
import { addDays, allDayRange, fromKey, sameDay, type Occ } from "./types";

/**
 * Multi-day and all-day events as one bar across the days of a row (week,
 * 4 days, a month week), stacked in lanes without overlap, with arrows where
 * they continue past the row. Bars move and resize by whole days.
 */

const DAY = 86_400_000;

/** All-day events and timed events of 24 hours or more sit in the all-day row (as in Google Calendar). */
export const isLong = (o: Occ) => o.allDay || new Date(o.end).getTime() - new Date(o.start).getTime() >= DAY;
/** Spans more than one date: the month view draws these as bars too. */
export const isMultiDate = (o: Occ) => isLong(o) || !sameDay(new Date(o.start), new Date(new Date(o.end).getTime() - 1));

/** Whether an event covers a local date. */
export function covers(o: Occ, d: Date) {
  if (o.allDay) {
    const r = allDayRange(o);
    return r.start <= d && r.end > d;
  }
  return new Date(o.start) < addDays(d, 1) && new Date(o.end) > d;
}

export type Entry<T> = { key: string; data: T; covers: (d: Date) => boolean };
export type Placed<T> = { key: string; data: T; col: number; span: number; lane: number; contL: boolean; contR: boolean };

/** Give each entry the first lane free across all its columns, in the order given (longest-first ordering is the caller's). */
export function stack<T>(row: Date[], entries: Entry<T>[]) {
  const used: boolean[][] = [];
  const placed: Placed<T>[] = [];
  for (const e of entries) {
    const cols = row.flatMap((d, i) => (e.covers(d) ? [i] : []));
    if (!cols.length) continue;
    const col = cols[0], span = cols[cols.length - 1] - col + 1;
    let lane = 0;
    while (used[lane]?.slice(col, col + span).some(Boolean)) lane++;
    used[lane] ??= [];
    for (let k = col; k < col + span; k++) used[lane][k] = true;
    placed.push({ key: e.key, data: e.data, col, span, lane, contL: e.covers(addDays(row[col], -1)), contR: e.covers(addDays(row[col + span - 1], 1)) });
  }
  return { placed, lanes: used.length };
}

/** Bars first (earliest, then longest), the rest after. */
export function byLength(a: Occ, b: Occ) {
  const as = a.allDay ? allDayRange(a).start.getTime() : new Date(a.start).getTime();
  const bs = b.allDay ? allDayRange(b).start.getTime() : new Date(b.start).getTime();
  const al = new Date(a.end).getTime() - new Date(a.start).getTime();
  const bl = new Date(b.end).getTime() - new Date(b.start).getTime();
  const ad = Math.floor(as / DAY), bd = Math.floor(bs / DAY);
  return ad - bd || bl - al || Number(b.allDay) - Number(a.allDay) || as - bs;
}

export const occKey = (o: Occ) => o.id + (o.occ ?? "");

/** The date under a point (cells carry data-date). */
export function dateAtPoint(x: number, y: number) {
  for (const el of document.elementsFromPoint(x, y)) {
    const d = (el as HTMLElement).dataset?.date;
    if (d) return d;
  }
  return null;
}

type Mode = "move" | "l" | "r";
/** New start and end (local dates for all-day, instants for timed) after moving or resizing by whole days. */
export function shifted(o: Occ, mode: Mode, delta: number) {
  if (o.allDay) {
    const r = allDayRange(o);
    let s = r.start, e = r.end;
    if (mode === "move") (s = addDays(s, delta)), (e = addDays(e, delta));
    else if (mode === "l") s = addDays(s, Math.min(delta, Math.round((e.getTime() - s.getTime()) / DAY) - 1));
    else e = addDays(e, Math.max(delta, 1 - Math.round((e.getTime() - s.getTime()) / DAY)));
    return { s, e };
  }
  let s = new Date(o.start), e = new Date(o.end);
  if (mode === "move") (s = addDays(s, delta)), (e = addDays(e, delta));
  else if (mode === "l") {
    const ns = addDays(s, delta);
    s = ns < e ? ns : s;
  } else {
    const ne = addDays(e, delta);
    e = ne > s ? ne : e;
  }
  return { s, e };
}
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
export function withRange(o: Occ, s: Date, e: Date): Occ {
  return { ...o, start: o.allDay ? utcMidnight(s) : s.toISOString(), end: o.allDay ? utcMidnight(e) : e.toISOString() };
}

type Drag = { o: Occ; mode: Mode; from: string; delta: number; moved: boolean; x0: number; y0: number };

/**
 * Drag a bar by whole days: move it, or pull its left / right end (.rs-l / .rs-r).
 * A click without movement opens it. Listens on the window, so the bar may re-render in another week row.
 */
export function useBarDrag(onMove: (o: Occ, s: Date, e: Date) => void, onOpen: (o: Occ) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<Drag | null>(null);
  ref.current = drag;
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = ref.current;
      if (!d) return;
      const moved = d.moved || Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 4;
      const at = dateAtPoint(e.clientX, e.clientY);
      const delta = at && d.from ? Math.round((fromKey(at).getTime() - fromKey(d.from).getTime()) / DAY) : d.delta;
      if (moved !== d.moved || delta !== d.delta) setDrag({ ...d, moved, delta });
    };
    const up = () => {
      const d = ref.current;
      setDrag(null);
      if (!d) return;
      if (!d.moved) return onOpen(d.o);
      if (!d.o.canEdit || !d.delta) return;
      const r = shifted(d.o, d.mode, d.delta);
      onMove(d.o, r.s, r.e);
    };
    const cancel = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [!!drag]); // eslint-disable-line react-hooks/exhaustive-deps

  const down = (e: React.PointerEvent, o: Occ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const t = e.target as HTMLElement;
    const mode: Mode = o.canEdit && t.classList.contains("rs-l") ? "l" : o.canEdit && t.classList.contains("rs-r") ? "r" : "move";
    setDrag({ o, mode, from: dateAtPoint(e.clientX, e.clientY) ?? "", delta: 0, moved: false, x0: e.clientX, y0: e.clientY });
  };
  /** The events with the dragged one at its new place (a live preview). */
  const preview = (events: Occ[]) => {
    if (!drag?.moved || !drag.o.canEdit || !drag.delta) return events;
    const r = shifted(drag.o, drag.mode, drag.delta);
    const k = occKey(drag.o);
    return events.map((x) => (occKey(x) === k ? withRange(x, r.s, r.e) : x));
  };
  return { drag, down, preview, draggingKey: drag?.moved ? occKey(drag.o) : null };
}

