"use client";
import { useState } from "react";
import { Bars, PeriodPicker, Seg, useRead } from "./common";

type Bucket = { k: string; label: string; meetings: number; scored: number; read: number | null; sentiment: number | null; engagement: number | null; onTime: number | null; timed: number };
type Data = { scope: string; meetings: number; overall: Bucket; day: Bucket[]; time: Bucket[]; size: Bucket[]; duration: Bucket[] };
type Metric = "read" | "sentiment" | "engagement" | "onTime";

/** Meeting Policy: how meetings go by day, time, size and length. Personal; admins can switch to the whole workspace. */
export default function Policy({ admin }: { admin: boolean }) {
  const [days, setDays] = useState(90);
  const [scope, setScope] = useState<"me" | "workspace">("me");
  const [metric, setMetric] = useState<Metric>("read");
  const { data, err } = useRead<Data>(`/read/policy?days=${days}&scope=${scope}`);
  const rows = (bs: Bucket[]) => bs.map((b) => ({ label: b.label, value: b[metric], count: metric === "onTime" ? b.timed : b.meetings, note: metric === "onTime" ? "timed" : "mtg" }));
  const avg = data?.overall[metric] ?? null;
  const unit = metric === "onTime" ? "%" : "";
  const card = (title: string, bs: Bucket[] | undefined) => (
    <section className="mt-card">
      <h2>{title}</h2>
      {bs ? <Bars rows={rows(bs)} avg={avg} unit={unit} /> : <p className="rd-empty">Loading…</p>}
    </section>
  );
  return (
    <div className="rd-page">
      <div className="rd-head">
        <h2>Meeting Policy</h2>
        {admin && <Seg label="Whose meetings" value={scope} onChange={setScope} options={[{ v: "me", label: "Mine" }, { v: "workspace", label: "Workspace" }]} />}
        <PeriodPicker days={days} onChange={setDays} />
      </div>
      <p className="rd-sub">
        {data ? `${data.meetings} meeting${data.meetings === 1 ? "" : "s"}${scope === "workspace" ? " across the workspace" : " you were in"}; ${data.overall.scored} with scores.` : "Loading…"} Scores come from speech and text only. On time = started within 5 minutes of the calendar time. The line marks the average.
      </p>
      {err && <p className="mt-error">{err}</p>}
      <Seg label="Measure" value={metric} onChange={setMetric} options={[{ v: "read", label: "Read score" }, { v: "sentiment", label: "Sentiment" }, { v: "engagement", label: "Engagement" }, { v: "onTime", label: "On-time rate" }]} />
      {data && (
        <div className="rd-grid">
          <div className="rd-stat"><div className="k">Average {metric === "onTime" ? "on-time rate" : metric === "read" ? "Read score" : metric}</div><div className="v">{avg == null ? "–" : `${avg}${unit}`}</div><div className="r">{metric === "onTime" ? `${data.overall.timed} meetings with a calendar time` : `${data.overall.scored} scored meetings`}</div></div>
        </div>
      )}
      <div className="rd-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        {card("Day of week", data?.day)}
        {card("Time of day", data?.time)}
        {card("Size", data?.size)}
        {card("Length", data?.duration)}
      </div>
    </div>
  );
}
