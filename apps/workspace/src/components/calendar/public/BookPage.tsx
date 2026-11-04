"use client";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Globe, MapPin, Phone, Video } from "lucide-react";

type Page = { title: string; description: string; minutes: number; tz: string; owner: string; locationKind: string; location: string; questions: { id: string; label: string; required: boolean }[]; color: string };
type Day = { day: string; slots: string[] };
const API = "/workspace/api/calendar/book";
const WINDOW = 14;

const addDays = (key: string, n: number) => {
  const [y, m, d] = key.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
};

export default function BookPage({ slug }: { slug: string }) {
  const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [page, setPage] = useState<Page | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);
  const [err, setErr] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", note: "" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ when: string; manage?: string } | null>(null);

  useEffect(() => {
    setDays(null);
    fetch(`${API}/${encodeURIComponent(slug)}?from=${from}&days=${WINDOW}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "This booking page isn't available.");
        setPage(j.page);
        setDays(j.days);
        setDay((d) => (d && j.days.some((x: Day) => x.day === d && x.slots.length) ? d : j.days.find((x: Day) => x.slots.length)?.day ?? null));
      })
      .catch((e) => setErr(e.message));
  }, [slug, from]);

  const slots = useMemo(() => days?.find((d) => d.day === day)?.slots ?? [], [days, day]);
  const fmtDay = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const fmtSlot = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const book = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slot) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`${API}/${encodeURIComponent(slug)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: slot, ...form, answers }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 409) setSlot(null);
        throw new Error(j.error ?? "Couldn't book that time.");
      }
      setDone({ when: `${new Date(slot).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })} at ${fmtSlot(slot)}`, manage: j.manage });
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const where = page?.locationKind === "meet" ? <><Video size={16} /><span>Video call (link in your invite)</span></> : page?.locationKind === "phone" ? <><Phone size={16} /><span>Phone call</span></> : page?.locationKind === "place" ? <><MapPin size={16} /><span>{page.location}</span></> : null;

  return (
    <main className="pub">
      <div className="pub-card wide">
        {!page && !err && <p>Loading…</p>}
        {err && !page && <p className="ws-error" role="alert">{err}</p>}
        {page && done && (
          <div role="status">
            <p className="ws-muted" style={{ margin: 0 }}>You're booked with {page.owner}</p>
            <h1>{page.title}</h1>
            <div className="meta">
              <div><Clock size={16} /><span>{done.when} ({page.minutes} minutes)</span></div>
              {where && <div>{where}</div>}
            </div>
            <p>An invitation is on its way to {form.email}.</p>
            {done.manage && <p><a href={done.manage}>Change or cancel</a></p>}
          </div>
        )}
        {page && !done && (
          <>
            <p className="ws-muted" style={{ margin: 0 }}>{page.owner}</p>
            <h1>{page.title}</h1>
            <div className="meta">
              <div><Clock size={16} /><span>{page.minutes} minutes</span></div>
              {where && <div>{where}</div>}
              <div><Globe size={16} /><span>Times are shown in your time zone ({myTz.replace(/_/g, " ")})</span></div>
            </div>
            {page.description && <p style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{page.description}</p>}
            {!slot ? (
              <>
                <div className="ws-row" style={{ justifyContent: "space-between", marginTop: 6 }}>
                  <button className="ix-iconbtn" aria-label="Earlier dates" disabled={from <= new Date().toISOString().slice(0, 10)} onClick={() => setFrom(addDays(from, -WINDOW))}><ChevronLeft size={18} /></button>
                  <b style={{ fontSize: 14 }}>{fmtDay(from)} – {fmtDay(addDays(from, WINDOW - 1))}</b>
                  <button className="ix-iconbtn" aria-label="Later dates" onClick={() => setFrom(addDays(from, WINDOW))}><ChevronRight size={18} /></button>
                </div>
                <div className="bk">
                  <div className="bk-days" role="group" aria-label="Dates">
                    {(days ?? []).map((d) => {
                      const dt = new Date(`${d.day}T12:00:00Z`);
                      return (
                        <button key={d.day} disabled={!d.slots.length} aria-pressed={day === d.day} onClick={() => setDay(d.day)}>
                          {dt.toLocaleDateString([], { weekday: "short", timeZone: "UTC" })}
                          <b>{dt.getUTCDate()}</b>
                          <small>{d.slots.length ? `${d.slots.length} free` : "—"}</small>
                        </button>
                      );
                    })}
                    {days === null && <p className="ws-muted">Finding free times…</p>}
                  </div>
                  <div className="bk-slots" role="group" aria-label="Times">
                    {day && <b style={{ fontSize: 13 }}>{fmtDay(day)}</b>}
                    {days && !day && <p className="ws-muted">No free times in these two weeks. Try later dates.</p>}
                    {slots.map((s) => <button key={s} onClick={() => setSlot(s)}>{fmtSlot(s)}</button>)}
                  </div>
                </div>
              </>
            ) : (
              <form onSubmit={book} style={{ marginTop: 10 }}>
                <p style={{ fontWeight: 600 }}>
                  {new Date(slot).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}, {fmtSlot(slot)} – {fmtSlot(new Date(new Date(slot).getTime() + page.minutes * 60000).toISOString())}
                  <button type="button" className="ws-link" style={{ marginLeft: 8 }} onClick={() => setSlot(null)}>Change</button>
                </p>
                <div className="ws-field"><label className="ws-label" htmlFor="bk-name">Your name</label><input id="bk-name" className="ws-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" /></div>
                <div className="ws-field"><label className="ws-label" htmlFor="bk-email">Email</label><input id="bk-email" className="ws-input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" /></div>
                {page.questions.map((q) => (
                  <div key={q.id} className="ws-field">
                    <label className="ws-label" htmlFor={`bk-${q.id}`}>{q.label}{q.required ? " *" : ""}</label>
                    <input id={`bk-${q.id}`} className="ws-input" required={q.required} value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                  </div>
                ))}
                <div className="ws-field"><label className="ws-label" htmlFor="bk-note">Anything to share before the meeting?</label><textarea id="bk-note" className="ws-textarea" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
                {err && <p className="ws-error" role="alert">{err}</p>}
                <button className="ws-btn primary" disabled={busy}>{busy ? "Booking…" : "Book"}</button>
              </form>
            )}
          </>
        )}
      </div>
      <p className="pub-foot">Powered by IOTx Calendar</p>
    </main>
  );
}
