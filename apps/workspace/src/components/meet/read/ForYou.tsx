"use client";
import { useState } from "react";
import { CheckCircle2, CircleHelp, ListTodo, Plus, Sparkles, UserX } from "lucide-react";
import { meetApi } from "../api";
import { day, PeriodPicker, Seg, useRead } from "./common";

type Topic = { name: string; meetings: { code: string; title: string; at: string; note: string; href: string }[] };
type Missed = { code: string; title: string; at: string; topics: string[]; summary: string; engagement: number | null; href: string; hasReport: boolean };
type Action = { code: string; meeting: string; at: string; idx: number; title: string; owner: string; due: string; mine: boolean; href: string; taskHref: string | null };
type Question = { code: string; meeting: string; at: string; question: string; askedBy: string; answered: boolean; mine: boolean; href: string };
type Data = { topics: Topic[]; missed: Missed[]; actions: Action[]; questions: Question[]; reports: number };

/** For You: topics over time, what you missed, action items and key questions (For me / All). */
export default function ForYou({ canTasks }: { canTasks: boolean }) {
  const [days, setDays] = useState(30);
  const [aWho, setAWho] = useState<"me" | "all">("me");
  const [qWho, setQWho] = useState<"me" | "all">("all");
  const { data, err, setData } = useRead<Data>(`/read/foryou?days=${days}`);
  const [msg, setMsg] = useState("");

  const toTask = async (a: Action) => {
    setMsg("");
    try {
      const r = await meetApi<{ taskHref: string }>("/read/actions/task", { body: { code: a.code, idx: a.idx } });
      setData((d) => d && { ...d, actions: d.actions.map((x) => (x.code === a.code && x.idx === a.idx ? { ...x, taskHref: r.taskHref } : x)) });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const actions = (data?.actions ?? []).filter((a) => aWho === "all" || a.mine);
  const questions = (data?.questions ?? []).filter((q) => qWho === "all" || q.mine);

  return (
    <div className="rd-page">
      <div className="rd-head">
        <h2>For You</h2>
        <PeriodPicker days={days} onChange={setDays} />
      </div>
      <p className="rd-sub">{data ? `From ${data.reports} meeting report${data.reports === 1 ? "" : "s"} you can open.` : "Loading…"}</p>
      {err && <p className="mt-error">{err}</p>}

      <section className="mt-card">
        <h2><Sparkles size={15} style={{ verticalAlign: -2 }} /> Topics</h2>
        {data && !data.topics.length && <p className="rd-empty">No topics yet. They come from meeting reports.</p>}
        {data?.topics.slice(0, 12).map((t) => (
          <div key={t.name} className="rd-topic">
            <h3>{t.name} <span className="rd-tag">{t.meetings.length} meeting{t.meetings.length === 1 ? "" : "s"}</span></h3>
            <div className="rd-steps">
              {t.meetings.map((m) => (
                <div key={m.code} className="rd-step">
                  <span className="d">{day(m.at)}</span>
                  <span><a href={m.href}><b>{m.title}</b></a>{m.note ? ` — ${m.note}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="mt-card">
        <h2><UserX size={15} style={{ verticalAlign: -2 }} /> What you missed</h2>
        {data && !data.missed.length && <p className="rd-empty">You were in every meeting you were invited to.</p>}
        {data?.missed.map((m) => (
          <div key={m.code + m.at} className="rd-item">
            <div className="body">
              <div className="t"><a href={m.href}>{m.title}</a></div>
              <div className="m">{day(m.at)}{m.engagement != null ? ` · engagement ${m.engagement}` : ""}{!m.hasReport ? " · no report" : ""}</div>
              {m.summary && <div style={{ fontSize: 13, marginTop: 4 }}>{m.summary}</div>}
              {!!m.topics.length && <div className="rd-tags" style={{ marginTop: 6 }}>{m.topics.map((t) => <span key={t} className="rd-tag">{t}</span>)}</div>}
            </div>
          </div>
        ))}
      </section>

      <section className="mt-card">
        <div className="rd-head" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, flex: 1 }}><ListTodo size={15} style={{ verticalAlign: -2 }} /> Action items</h2>
          <Seg label="Whose action items" value={aWho} onChange={setAWho} options={[{ v: "me", label: "For me" }, { v: "all", label: "All" }]} />
        </div>
        {msg && <p className="mt-error">{msg}</p>}
        {data && !actions.length && <p className="rd-empty">{aWho === "me" ? "Nothing assigned to you in this period." : "No action items in this period."}</p>}
        {actions.map((a) => (
          <div key={`${a.code}-${a.idx}`} className="rd-item">
            <div className="body">
              <div className="t">{a.title}</div>
              <div className="m">{a.owner || "No owner"}{a.due ? ` · due ${a.due}` : ""} · <a href={a.href}>{a.meeting}</a>, {day(a.at)}</div>
            </div>
            {a.taskHref ? (
              <a className="mt-btn sm" href={a.taskHref}><CheckCircle2 size={13} className="rd-ok" /> Task</a>
            ) : canTasks ? (
              <button className="mt-btn sm" onClick={() => toTask(a)}><Plus size={13} /> Make a task</button>
            ) : null}
          </div>
        ))}
      </section>

      <section className="mt-card">
        <div className="rd-head" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, flex: 1 }}><CircleHelp size={15} style={{ verticalAlign: -2 }} /> Key questions</h2>
          <Seg label="Whose questions" value={qWho} onChange={setQWho} options={[{ v: "me", label: "For me" }, { v: "all", label: "All" }]} />
        </div>
        {data && !questions.length && <p className="rd-empty">No key questions in this period.</p>}
        {questions.map((q, i) => (
          <div key={`${q.code}-${i}`} className="rd-item">
            <div className="body">
              <div className="t">{q.question}</div>
              <div className="m">{q.askedBy ? `Asked by ${q.askedBy}` : "Asked"} · {q.answered ? <span className="rd-ok">answered</span> : <span className="rd-bad">open</span>} · <a href={q.href}>{q.meeting}</a>, {day(q.at)}</div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
