"use client";
import { useEffect, useState } from "react";
import { meetApi } from "../api";

/** Shared bits for the across-meetings sections: data loading, the period picker, dates, and small inline-SVG charts. */

export function useRead<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setErr("");
    meetApi<T>(path).then((d) => live && setData(d)).catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, err, reload: () => setN((x) => x + 1), setData };
}

export const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
export function PeriodPicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="rd-seg" role="group" aria-label="Period">
      {PERIODS.map((p) => (
        <button key={p.days} className={p.days === days ? "on" : ""} onClick={() => onChange(p.days)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="rd-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
export const dayTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * A per-meeting line chart (inline SVG): one point per meeting, an optional
 * target band, each point a link to its report.
 */
export function Trend({ points, band, unit = "", height = 150, label }: { points: { label: string; value: number; href?: string }[]; band?: [number, number]; unit?: string; height?: number; label: string }) {
  if (!points.length) return <p className="rd-empty">No meetings in this period.</p>;
  const W = 640, H = height, L = 34, R = 10, T = 10, B = 22;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals, ...(band ?? [])), hi = Math.max(...vals, ...(band ?? []));
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  const pad = (hi - lo) * 0.1;
  lo = Math.max(0, lo - pad); hi += pad;
  const x = (i: number) => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo, (lo + hi) / 2, hi];
  const every = Math.max(1, Math.ceil(points.length / 8));
  return (
    <svg className="rd-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {band && <rect x={L} width={W - L - R} y={y(band[1])} height={Math.max(0, y(band[0]) - y(band[1]))} fill="#16a34a" opacity={0.1} />}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" opacity={0.08} />
          <text x={L - 6} y={y(t) + 3} textAnchor="end">{Math.round(t)}</text>
        </g>
      ))}
      <polyline fill="none" stroke="var(--accent)" strokeWidth={2} points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
      {points.map((p, i) => {
        const out = band && (p.value < band[0] || p.value > band[1]);
        const dot = <circle cx={x(i)} cy={y(p.value)} r={4.5} fill={out ? "#d97706" : "var(--accent)"} stroke="var(--ix-panel)" strokeWidth={1.5}><title>{`${p.label}: ${p.value}${unit}`}</title></circle>;
        return (
          <g key={i}>
            {p.href ? <a href={p.href}>{dot}</a> : dot}
            {i % every === 0 && <text x={x(i)} y={H - 6} textAnchor="middle">{p.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal bars with the overall average marked. */
export function Bars({ rows, max = 100, avg, unit = "" }: { rows: { label: string; value: number | null; count: number; note?: string }[]; max?: number; avg?: number | null; unit?: string }) {
  return (
    <div className="rd-bars">
      {rows.map((r) => (
        <div key={r.label} className="rd-bar">
          <span>{r.label}</span>
          <span className="track" title={r.value == null ? "No data" : `${r.value}${unit}`}>
            {r.value != null && <span className="fill" style={{ width: `${Math.max(2, Math.min(100, (r.value / max) * 100))}%` }} />}
            {avg != null && <span className="avg" style={{ left: `${Math.min(100, (avg / max) * 100)}%` }} />}
          </span>
          <span className="num">
            <b>{r.value == null ? "–" : `${r.value}${unit}`}</b> · {r.count} {r.note ?? "mtg"}
          </span>
        </div>
      ))}
    </div>
  );
}
