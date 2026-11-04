"use client";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/client";
import { addDays, dateKey, fmtTime, fromKey, type Person } from "./types";

const FROM_H = 7, TO_H = 21, ROW = 28; // px per half hour

/** "Find a time": everyone's busy blocks side by side; click a free slot to book it. */
export default function FindTime({
  people, me, initial, date, onPick, onClose,
}: {
  people: Person[];
  me: Person;
  initial: string[];
  date: string;
  onPick: (start: Date, end: Date, userIds: string[]) => void;
  onClose: () => void;
}) {
  const [ids, setIds] = useState<string[]>(initial.filter((x) => x !== me.id));
  const [day, setDay] = useState(date);
  const [dur, setDur] = useState(30);
  const [busy, setBusy] = useState<Record<string, { start: string; end: string }[]>>({});
  const [q, setQ] = useState("");
  const everyone = [me.id, ...ids];

  useEffect(() => {
    const f = fromKey(day);
    api<{ busy: typeof busy }>(`/calendar/busy?users=${everyone.join(",")}&from=${f.toISOString()}&to=${addDays(f, 1).toISOString()}`).then((d) => setBusy(d.busy)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, ids.join(",")]);

  const d0 = fromKey(day);
  const minOf = (t: Date) => (t.getTime() - d0.getTime()) / 60000;
  const free = useMemo(() => {
    const slots: number[] = [];
    for (let m = FROM_H * 60; m + dur <= TO_H * 60; m += 30) {
      const s = d0.getTime() + m * 60000, e = s + dur * 60000;
      const clash = everyone.some((u) => (busy[u] ?? []).some((b) => new Date(b.start).getTime() < e && new Date(b.end).getTime() > s));
      if (!clash && s > Date.now()) slots.push(m);
    }
    return slots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, dur, day]);

  const matches = q.trim() ? people.filter((p) => p.id !== me.id && !ids.includes(p.id) && (p.name + p.email).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  const nameOf = (id: string) => (id === me.id ? "You" : people.find((p) => p.id === id)?.name ?? "Someone");
  const rows = (TO_H - FROM_H) * 2;

  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-modal wide" role="dialog" aria-label="Find a time">
        <header>
          <h3>Find a time</h3>
          <button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="body">
          <div className="ws-row" style={{ marginBottom: 10 }}>
            <button className="ws-btn" onClick={() => setDay(dateKey(addDays(fromKey(day), -1)))} aria-label="Previous day">‹</button>
            <input type="date" className="ws-input" style={{ width: 160 }} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day" />
            <button className="ws-btn" onClick={() => setDay(dateKey(addDays(fromKey(day), 1)))} aria-label="Next day">›</button>
            <select className="ws-select" style={{ width: "auto" }} value={dur} onChange={(e) => setDur(Number(e.target.value))} aria-label="Length">
              {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
            </select>
            <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
              <input className="ws-input" placeholder="Add a colleague" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Add a colleague" />
              {matches.length > 0 && (
                <div className="suggest">
                  {matches.map((p) => <button key={p.id} onClick={() => { setIds([...ids, p.id]); setQ(""); }}>{p.name} <span className="ws-muted">{p.email}</span></button>)}
                </div>
              )}
            </div>
          </div>
          <div className="ws-row" style={{ marginBottom: 10 }}>
            {ids.map((id) => (
              <span key={id} className="ws-chip">{nameOf(id)}<button aria-label="Remove" onClick={() => setIds(ids.filter((x) => x !== id))}><X size={12} /></button></span>
            ))}
            <span className="ws-muted" style={{ fontSize: 12 }}>{free.length ? `${free.length} free slots — green bands work for everyone` : "No time free for everyone this day"}</span>
          </div>
          <div className="fat" style={{ gridTemplateColumns: `52px repeat(${everyone.length}, minmax(90px, 1fr))` }}>
            <div />
            {everyone.map((u) => <div key={u} className="fat-head">{nameOf(u)}</div>)}
            <div style={{ position: "relative", height: rows * ROW }}>
              {Array.from({ length: TO_H - FROM_H }, (_, i) => (
                <div key={i} style={{ position: "absolute", top: i * 2 * ROW - 6, right: 6, fontSize: 10.5, color: "var(--ix-muted)" }}>
                  {new Date(2000, 0, 1, FROM_H + i).toLocaleTimeString([], { hour: "numeric" })}
                </div>
              ))}
            </div>
            {everyone.map((u, ui) => (
              <div key={u} className="fat-col" style={{ height: rows * ROW }}>
                {free.map((m) => (
                  <div key={`f${m}`} className="fat-free" title={`Free at ${fmtTime(new Date(d0.getTime() + m * 60000))}`} style={{ top: ((m - FROM_H * 60) / 30) * ROW, height: ROW }}
                    onClick={() => onPick(new Date(d0.getTime() + m * 60000), new Date(d0.getTime() + (m + dur) * 60000), ids)} />
                ))}
                {(busy[u] ?? []).map((b, i) => {
                  const s = Math.max(minOf(new Date(b.start)), FROM_H * 60), e = Math.min(minOf(new Date(b.end)), TO_H * 60);
                  if (e <= s) return null;
                  return (
                    <div key={i} className="fat-busy" style={{ top: ((s - FROM_H * 60) / 30) * ROW, height: ((e - s) / 30) * ROW - 2 }}>
                      Busy
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="ws-row" style={{ marginTop: 12 }}>
            {free.slice(0, 12).map((m) => {
              const s = new Date(d0.getTime() + m * 60000);
              return (
                <button key={m} className="ws-btn" onClick={() => onPick(s, new Date(s.getTime() + dur * 60000), ids)}>
                  {fmtTime(s)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
