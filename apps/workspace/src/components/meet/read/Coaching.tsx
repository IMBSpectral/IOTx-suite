"use client";
import { useState } from "react";
import { clock, day, PeriodPicker, Seg, Trend, useRead } from "./common";

type Range = { min: number; max: number; avg: number } | null;
type Row = { code: string; title: string; at: string; href: string; wpm: number; words: number; talkSec: number; fillers: number; fillersPerMin: number; nonInclusive: number; questions: number; longestMonologueSec: number; talkRatio: number; speakers: number };
type Moment = { kind: "fast" | "slow" | "filler" | "noninclusive" | "monologue"; code: string; title: string; start: number; text: string; detail: string; href: string };
type Data = {
  person: { id: string; name: string };
  target: { low: number; high: number };
  summary: { meetings: number; wpm: Range; fillersPerMin: Range; nonInclusive: Range; questions: Range; talkRatio: Range; longestMonologueSec: Range; paceInTarget: number | null };
  meetings: Row[];
  moments: Moment[];
};
type Metric = "wpm" | "fillersPerMin" | "nonInclusive" | "questions" | "talkRatio" | "longestMonologueSec";
const METRICS: { v: Metric; label: string; unit: string; help: string }[] = [
  { v: "wpm", label: "Pace", unit: " wpm", help: "Words a minute while you talk. Aim for 130–175." },
  { v: "fillersPerMin", label: "Fillers", unit: "/min", help: "Filler words (um, uh, you know…) per minute of talking." },
  { v: "nonInclusive", label: "Inclusion", unit: "", help: "Non-inclusive terms (guys, manpower, blacklist…)." },
  { v: "questions", label: "Questions", unit: "", help: "Questions you asked." },
  { v: "talkRatio", label: "Talk ratio", unit: "%", help: "Your share of the meeting's talking." },
  { v: "longestMonologueSec", label: "Monologue", unit: " s", help: "Your longest stretch without a break." },
];
const KIND: Record<Moment["kind"], string> = { fast: "Too fast", slow: "Slow", filler: "Fillers", noninclusive: "Non-inclusive", monologue: "Long monologue" };

/** Coaching: speech numbers per meeting (from the transcript, never faces), with moments outside the target. */
export default function Coaching({ admin, people }: { admin: boolean; people: { id: string; name: string }[] }) {
  const [days, setDays] = useState(30);
  const [who, setWho] = useState("");
  const [metric, setMetric] = useState<Metric>("wpm");
  const { data, err } = useRead<Data>(`/read/coaching?days=${days}${who ? `&user=${who}` : ""}`);
  const M = METRICS.find((m) => m.v === metric)!;
  const fmt = (r: Range, unit: string) => (r ? `${r.min}–${r.max}${unit}` : "–");
  const s = data?.summary;
  const paceOk = s?.wpm && s.wpm.avg >= (data?.target.low ?? 130) && s.wpm.avg <= (data?.target.high ?? 175);

  return (
    <div className="rd-page">
      <div className="rd-head">
        <h2>Coaching{data && data.person.id !== undefined && who ? `: ${data.person.name}` : ""}</h2>
        {admin && (
          <select className="mt-select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person" style={{ maxWidth: 200 }}>
            <option value="">Me</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <PeriodPicker days={days} onChange={setDays} />
      </div>
      <p className="rd-sub">From what was said in {s ? `${s.meetings} meeting${s.meetings === 1 ? "" : "s"}` : "your meetings"} with a report. Nothing here looks at video or faces.</p>
      {err && <p className="mt-error">{err}</p>}
      {s && (
        <div className="rd-grid">
          <div className={`rd-stat ${s.wpm ? (paceOk ? "good" : "warn") : ""}`}><div className="k">Talking pace (target {data!.target.low}–{data!.target.high})</div><div className="v">{s.wpm ? `${s.wpm.avg} wpm` : "–"}</div><div className="r">Range {fmt(s.wpm, "")}{s.paceInTarget != null ? ` · ${s.paceInTarget}% of meetings on target` : ""}</div></div>
          <div className="rd-stat"><div className="k">Filler words</div><div className="v">{s.fillersPerMin ? `${s.fillersPerMin.avg}/min` : "–"}</div><div className="r">Range {fmt(s.fillersPerMin, "/min")}</div></div>
          <div className={`rd-stat ${s.nonInclusive && s.nonInclusive.max > 0 ? "warn" : s.nonInclusive ? "good" : ""}`}><div className="k">Non-inclusive terms</div><div className="v">{s.nonInclusive ? s.nonInclusive.avg : "–"}</div><div className="r">per meeting · range {fmt(s.nonInclusive, "")}</div></div>
          <div className="rd-stat"><div className="k">Questions asked</div><div className="v">{s.questions ? s.questions.avg : "–"}</div><div className="r">per meeting · range {fmt(s.questions, "")}</div></div>
          <div className="rd-stat"><div className="k">Talk ratio</div><div className="v">{s.talkRatio ? `${s.talkRatio.avg}%` : "–"}</div><div className="r">Range {fmt(s.talkRatio, "%")}</div></div>
          <div className="rd-stat"><div className="k">Longest monologue</div><div className="v">{s.longestMonologueSec ? clock(s.longestMonologueSec.max) : "–"}</div><div className="r">Average {s.longestMonologueSec ? clock(s.longestMonologueSec.avg) : "–"}</div></div>
        </div>
      )}

      <section className="mt-card">
        <div className="rd-head" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Per meeting</h2>
          <Seg label="Metric" value={metric} onChange={setMetric} options={METRICS.map((m) => ({ v: m.v, label: m.label }))} />
        </div>
        <p className="rd-help" style={{ marginTop: 0 }}>{M.help}{metric === "wpm" ? " The green band is the target; orange points are outside it." : ""} Click a point to open the report.</p>
        {data && <Trend label={`${M.label} per meeting`} unit={M.unit} band={metric === "wpm" ? [data.target.low, data.target.high] : undefined} points={data.meetings.map((m) => ({ label: day(m.at), value: m[metric], href: m.href }))} />}
      </section>

      <section className="mt-card">
        <h2>Moments outside the target</h2>
        {data && !data.moments.length && <p className="rd-empty">No moments to look at in this period.</p>}
        <div className="mt-list">
          {data?.moments.slice(0, 40).map((m, i) => (
            <a key={i} className="mt-row" href={m.href}>
              <span className="when">{clock(m.start)}</span>
              <span className="t" title={m.text}>
                <b>{KIND[m.kind]}</b> · {m.detail}{m.text ? ` — “${m.text}”` : ""}
              </span>
              <span className="rd-tag">{m.title}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="mt-card">
        <h2>Meetings</h2>
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr><th>Meeting</th><th>Date</th><th className="n">Pace</th><th className="n">Fillers/min</th><th className="n">Non-incl.</th><th className="n">Questions</th><th className="n">Talk</th><th className="n">Monologue</th></tr>
            </thead>
            <tbody>
              {data?.meetings.slice().reverse().map((m) => (
                <tr key={m.code + m.at}>
                  <td><a href={m.href}>{m.title}</a></td>
                  <td>{day(m.at)}</td>
                  <td className={`n ${m.wpm < (data.target.low) || m.wpm > data.target.high ? "rd-bad" : ""}`}>{m.wpm}</td>
                  <td className="n">{m.fillersPerMin}</td>
                  <td className="n">{m.nonInclusive}</td>
                  <td className="n">{m.questions}</td>
                  <td className="n">{m.talkRatio}%</td>
                  <td className="n">{clock(m.longestMonologueSec)}</td>
                </tr>
              ))}
              {data && !data.meetings.length && <tr><td colSpan={8} className="rd-empty">No meetings with your speech in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
