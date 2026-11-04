"use client";
import { fmtTime, type Occ } from "./types";

/** One all-day or multi-day event drawn as a bar; pointy ends where it continues past the row. */
export default function Bar({
  o, contL, contR, style, dragging, onPointerDown, onOpen, timeLabel,
}: {
  o: Occ;
  contL: boolean;
  contR: boolean;
  style: React.CSSProperties;
  dragging?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
  /** Show the start time (timed multi-day events, in the row where they start). */
  timeLabel?: boolean;
}) {
  const cls = [
    "chipev bar",
    o.allDay ? "" : "long",
    contL ? "cont-l" : "",
    contR ? "cont-r" : "",
    o.eventType === "outOfOffice" ? "ooo" : "",
    o.eventType === "birthday" ? "bday" : "",
    o.myResponse === "no" ? "declined" : "",
    o.myResponse === "needs" || o.myResponse === "maybe" ? "tentative" : "",
    dragging ? "dragging" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      role="button"
      tabIndex={0}
      className={cls}
      style={{ background: o.color, cursor: o.canEdit ? "grab" : "pointer", ...style }}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      title={o.canEdit ? `${o.title} · drag to move, drag an end to change the days` : o.title}
      aria-label={o.title}
      data-bar=""
    >
      {o.canEdit && !contL && <span className="rs-l" aria-hidden />}
      {contL && <span className="arrow" aria-hidden>‹</span>}
      <span className="t">{timeLabel ? <small>{fmtTime(new Date(o.start))} </small> : null}{o.title}</span>
      {contR && <span className="arrow" aria-hidden>›</span>}
      {o.canEdit && !contR && <span className="rs-r" aria-hidden />}
    </div>
  );
}
