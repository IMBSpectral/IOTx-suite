"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, Clock, MapPin, Repeat, Users, Video } from "lucide-react";

type View = {
  title: string; when: string; start: string; end: string; allDay: boolean; tz: string; location: string; conferenceUrl: string | null; description: string; repeats: boolean; booking?: boolean;
  organizer: string; me: { email: string; name: string; response: string; comment: string }; guests: { name: string; response: string }[];
};
const NAMES: Record<string, string> = { yes: "Going", no: "Not going", maybe: "Maybe", needs: "No reply yet" };
const API = "/workspace/api/calendar/rsvp";

export default function RsvpPage({ token, answer }: { token: string; answer: "yes" | "no" | "maybe" | null }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [note, setNote] = useState("");
  const [propose, setPropose] = useState(false);
  const [pDate, setPDate] = useState("");
  const [pTime, setPTime] = useState("");
  const [pEnd, setPEnd] = useState("");
  const asked = useRef(false);

  const load = async () => {
    const r = await fetch(`${API}/${encodeURIComponent(token)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(j.error ?? "This invitation is no longer available.");
    setV(j);
    setNote(j.me.comment ?? "");
    const s = new Date(j.start), e = new Date(j.end);
    const pad = (n: number) => String(n).padStart(2, "0");
    setPDate(`${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`);
    setPTime(`${pad(s.getHours())}:${pad(s.getMinutes())}`);
    setPEnd(`${pad(e.getHours())}:${pad(e.getMinutes())}`);
    return j as View;
  };
  const reply = async (response: "yes" | "no" | "maybe", withNote = true) => {
    setBusy(true);
    try {
      const body: Record<string, string> = { response };
      if (withNote) body.comment = note;
      if (withNote && propose && pDate && pTime && pEnd) {
        body.proposeStart = new Date(`${pDate}T${pTime}`).toISOString();
        body.proposeEnd = new Date(`${pDate}T${pEnd}`).toISOString();
      }
      const r = await fetch(`${API}/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Couldn't save your reply.");
      setDone(`Thanks. Your reply (${NAMES[response]}) was sent to ${v?.organizer ?? "the organizer"}${body.proposeStart ? ", with your proposed time" : ""}.`);
      setV((x) => (x ? { ...x, me: { ...x.me, response } } : x));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!confirm("Cancel this booking?")) return;
    setBusy(true);
    const r = await fetch(`${API}/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cancel: true }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "Couldn't cancel.");
    setDone("Your booking was cancelled. The organizer has been told.");
    setV(null);
  };

  useEffect(() => {
    // The Yes / No / Maybe buttons in the email land here with ?r=: answer straight away (in the browser only, so link scanners don't).
    void load().then((j) => {
      if (j && answer && !asked.current) {
        asked.current = true;
        void reply(answer, false);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="pub">
      <div className="pub-card">
        {!v && !err && !done && <p>Loading…</p>}
        {err && <p className="ws-error" role="alert">{err}</p>}
        {done && <p role="status" style={{ fontWeight: 600 }}>{done}</p>}
        {v && (
          <>
            <p className="ws-muted" style={{ margin: 0, fontSize: 13 }}>{v.booking ? `Booked with ${v.organizer}` : `${v.organizer} invited you`}</p>
            <h1>{v.title}</h1>
            <div className="meta">
              <div><Clock size={16} /><span>{v.when}</span></div>
              {v.repeats && <div><Repeat size={16} /><span>Repeats</span></div>}
              {v.location && <div><MapPin size={16} /><span>{v.location}</span></div>}
              {v.conferenceUrl && <div><Video size={16} /><a href={v.conferenceUrl} target="_blank" rel="noreferrer">Join the video call</a></div>}
              {v.guests.length > 0 && (
                <div><Users size={16} /><span>{v.guests.map((g) => `${g.name} (${NAMES[g.response] ?? g.response})`).join(", ")}</span></div>
              )}
              <div><CalendarDays size={16} /><span>Your reply: <b>{NAMES[v.me.response] ?? v.me.response}</b></span></div>
            </div>
            {v.description && <p style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{v.description}</p>}
            <label className="ws-label" htmlFor="rsvp-note">Note for {v.organizer} (optional)</label>
            <textarea id="rsvp-note" className="ws-textarea" value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 60 }} />
            <label className="ws-row" style={{ gap: 6, margin: "8px 0", fontSize: 14 }}>
              <input type="checkbox" checked={propose} onChange={(e) => setPropose(e.target.checked)} /> Propose a new time
            </label>
            {propose && (
              <div className="ws-row">
                <input className="ws-input" type="date" style={{ width: 160 }} value={pDate} onChange={(e) => setPDate(e.target.value)} aria-label="Proposed date" />
                <input className="ws-input" type="time" style={{ width: 120 }} value={pTime} onChange={(e) => setPTime(e.target.value)} aria-label="Proposed start" />
                <span className="ws-muted">to</span>
                <input className="ws-input" type="time" style={{ width: 120 }} value={pEnd} onChange={(e) => setPEnd(e.target.value)} aria-label="Proposed end" />
              </div>
            )}
            <div className="pub-reply">
              <span style={{ alignSelf: "center", fontWeight: 600 }}>Going?</span>
              {(["yes", "no", "maybe"] as const).map((r) => (
                <button key={r} className={`ws-btn${v.me.response === r ? " primary" : ""}`} disabled={busy} onClick={() => reply(r)} aria-pressed={v.me.response === r}>
                  {r === "yes" ? "Yes" : r === "no" ? "No" : "Maybe"}
                </button>
              ))}
            </div>
            {v.booking && <button className="ws-link" onClick={cancel} disabled={busy} style={{ fontSize: 12.5 }}>Cancel this booking</button>}
          </>
        )}
      </div>
      <p className="pub-foot">Sent with IOTx Calendar. Your reply goes only to the organizer.</p>
    </main>
  );
}
