"use client";
import { useState } from "react";
import { CalendarDays, CheckCircle2, Megaphone } from "lucide-react";
import { meetApi } from "./api";

type W = { code: string; title: string; host: string; startsAt: string | null; open: boolean; approval: boolean; registration: boolean };

/** The public registration form for a webinar. */
export default function RegisterForm({ webinar: w }: { webinar: W }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<"" | "approved" | "pending">("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await meetApi<{ status: "approved" | "pending" }>(`/${w.code}/register`, { body: { name, email, company } });
      setDone(r.status);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-root mt-dark">
      <div className="mt-pre-top">
        <span className="mt-brand"><span className="mt-mark">IX</span> Meet</span>
      </div>
      <div className="mt-pre mt-pre-solo">
        <div className="mt-join">
          <p className="mt-note" style={{ margin: 0 }}><Megaphone size={13} style={{ verticalAlign: -2 }} /> Webinar</p>
          <h1>{w.title}</h1>
          <p className="sub">Hosted by {w.host}</p>
          {w.startsAt && <p className="mt-note" style={{ margin: 0 }}><CalendarDays size={13} style={{ verticalAlign: -2 }} /> {new Date(w.startsAt).toLocaleString([], { dateStyle: "full", timeStyle: "short" })}</p>}
          {done ? (
            <div className="mt-e2ee-box" role="status">
              <p style={{ margin: 0 }}><CheckCircle2 size={15} style={{ verticalAlign: -3 }} /> <b>{done === "approved" ? "You're registered." : "Thanks, you're on the list."}</b></p>
              <p className="mt-note" style={{ margin: 0 }}>
                {done === "approved" ? `We've emailed your personal join link to ${email}. Keep it to yourself: it's only for you.` : "The host reviews registrations. You'll get your join link by email once you're approved."}
              </p>
            </div>
          ) : !w.registration ? (
            <>
              <p>This webinar doesn&apos;t need registration.</p>
              <a className="mt-bigbtn" href={`/workspace/meet/${w.code}`} style={{ textAlign: "center", textDecoration: "none" }}>Go to the webinar</a>
            </>
          ) : !w.open ? (
            <p>Registration is closed.</p>
          ) : (
            <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="mt-note">Your name</span>
                <input className="mt-input" required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="mt-note">Email (your join link goes here)</span>
                <input className="mt-input" required type="email" maxLength={200} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="mt-note">Company (optional)</span>
                <input className="mt-input" maxLength={120} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} />
              </label>
              <button className="mt-bigbtn" disabled={busy || !name.trim() || !email.trim()}>{busy ? "Registering…" : "Register"}</button>
              {w.approval && <p className="mt-note" style={{ margin: 0 }}>The host approves each registration.</p>}
            </form>
          )}
          {err && <p className="mt-error">{err}</p>}
        </div>
      </div>
    </div>
  );
}
