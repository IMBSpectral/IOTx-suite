"use client";
import { useState } from "react";
import { CalendarClock, ListTodo, Mail, Newspaper } from "lucide-react";
import { meetApi } from "../api";
import { useRead } from "./common";

type Digest = {
  day: string;
  yesterday: { code: string; title: string; at: string; line: string; href: string }[];
  actions: { code: string; meeting: string; title: string; due: string; href: string }[];
  today: { id: string; title: string; start: string; end: string; join: string | null; prep: string }[];
};
const local = (href: string) => href.replace(/^https?:\/\/[^/]+/, "");

/** The Daily Read in the app: yesterday's meetings, your open action items, and today's meetings with prep links. */
export default function Daily() {
  const { data, err } = useRead<{ day: string; data: Digest; emailedAt: string | null; saved: boolean }>("/read/daily");
  const prefs = useRead<{ prefs: { dailyRead: boolean; dailyHour: number } }>("/read/settings");
  const [msg, setMsg] = useState("");
  const send = async () => {
    setMsg("");
    try {
      const r = await meetApi<{ sent: boolean }>("/read/daily/send", { body: {} });
      setMsg(r.sent ? "Sent to your email." : "Today's Daily Read was already emailed.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const d = data?.data;
  return (
    <div className="rd-page">
      <div className="rd-head">
        <h2><Newspaper size={18} style={{ verticalAlign: -3 }} /> Daily Read</h2>
        <button className="mt-btn sm" onClick={send}><Mail size={13} /> Email it to me</button>
      </div>
      <p className="rd-sub">
        {d ? new Date(`${d.day}T12:00:00Z`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : "Loading…"}
        {data?.emailedAt ? " · emailed this morning" : ""}
        {prefs.data && !prefs.data.prefs.dailyRead ? <> · Not emailed: turn it on in <a href="/workspace/meet/settings">Settings</a>.</> : prefs.data ? ` · Emailed daily around ${prefs.data.prefs.dailyHour}:00.` : ""}
      </p>
      {err && <p className="mt-error">{err}</p>}
      {msg && <p className="mt-note" role="status">{msg}</p>}
      <section className="mt-card">
        <h2>Yesterday&rsquo;s meetings</h2>
        {d && !d.yesterday.length && <p className="rd-empty">No meeting reports from yesterday.</p>}
        {d?.yesterday.map((y) => (
          <div key={y.code + y.at} className="rd-item"><div className="body"><div className="t"><a href={local(y.href)}>{y.title}</a></div>{y.line && <div style={{ fontSize: 13, marginTop: 3 }}>{y.line}</div>}</div></div>
        ))}
      </section>
      <section className="mt-card">
        <h2><ListTodo size={15} style={{ verticalAlign: -2 }} /> Your open action items</h2>
        {d && !d.actions.length && <p className="rd-empty">Nothing open for you.</p>}
        {d?.actions.map((a, i) => (
          <div key={i} className="rd-item"><div className="body"><div className="t">{a.title}</div><div className="m">{a.due ? `due ${a.due} · ` : ""}<a href={local(a.href)}>{a.meeting}</a></div></div></div>
        ))}
      </section>
      <section className="mt-card">
        <h2><CalendarClock size={15} style={{ verticalAlign: -2 }} /> Today</h2>
        {d && !d.today.length && <p className="rd-empty">No meetings today.</p>}
        <div className="mt-list">
          {d?.today.map((t) => (
            <div key={t.id + t.start} className="mt-row">
              <span className="when">{new Date(t.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              <span className="t">{t.title}</span>
              <a className="mt-btn sm" href={local(t.prep)}>Prepare</a>
              {t.join && <a className="mt-btn sm" href={t.join}>Join</a>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
