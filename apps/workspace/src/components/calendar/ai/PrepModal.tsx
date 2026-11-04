"use client";
import { useEffect, useState } from "react";
import { CheckSquare, Mail, Sparkles, Users, X, BookOpen } from "lucide-react";
import { api } from "@/lib/client";

type Prep = {
  event: { id: string; title: string; start: string; allDay: boolean };
  attendees: { name: string; email: string; response: string; internal: boolean }[];
  tasks: { id: string; title: string; status: string; owner: string; due: string | null; href: string }[];
  emails: { subject: string; from: string; date: string; snippet: string; href: string }[];
  knowledge?: { title: string; section: string; href: string | null }[];
  mail: "ok" | "none" | "offline";
  bullets: string[];
  aiError: string | null;
};
const REPLY: Record<string, string> = { yes: "Going", no: "Not going", maybe: "Maybe", needs: "No reply yet" };

/** "Prepare" on an event: guests, related tasks and emails, and a 3-bullet briefing. */
export default function PrepModal({ eventId, occ, suite, onClose }: { eventId: string; occ: string | null; suite: string; onClose: () => void }) {
  const [p, setP] = useState<Prep | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Prep>("/calendar/ai/prep", { body: { eventId, occ } }).then(setP).catch((e) => setErr((e as Error).message));
  }, [eventId, occ]);
  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-modal prep" role="dialog" aria-label="Meeting prep">
        <header>
          <span className="ai-orb"><Sparkles size={14} /></span>
          <h3>{p ? `Prepare: ${p.event.title}` : "Preparing…"}</h3>
          <button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="body">
          {err && <p className="ws-error">{err}</p>}
          {!p && !err && (
            <>
              <p className="ws-muted" style={{ marginTop: 0 }}>Reading guests, tasks and your mail…</p>
              <div className="ai-skel" style={{ height: 76 }} />
              <div className="ai-skel" style={{ height: 120 }} />
            </>
          )}
          {p && (
            <>
              <div className="prep-brief">
                <b><Sparkles size={13} /> Briefing</b>
                {p.bullets.length ? <ul>{p.bullets.map((b) => <li key={b}>{b}</li>)}</ul> : <p className="ws-muted">{p.aiError ?? "Not enough to go on yet."}</p>}
              </div>
              <h4 className="prep-h"><Users size={14} /> Guests</h4>
              {p.attendees.length === 0 && <p className="ws-muted">Just you.</p>}
              <div className="prep-people">
                {p.attendees.map((a) => (
                  <span key={a.email} className="ws-chip" title={a.email}>{a.name} <small className={`r-${a.response}`}>· {REPLY[a.response] ?? a.response}</small></span>
                ))}
              </div>
              <h4 className="prep-h"><CheckSquare size={14} /> Related tasks</h4>
              {p.tasks.length === 0 && <p className="ws-muted">No open tasks look related.</p>}
              {p.tasks.map((t) => (
                <a key={t.id} className="prep-row" href={t.href}>
                  <b>{t.title}</b>
                  <small>{t.owner} · {t.status === "doing" ? "In progress" : t.status === "review" ? "In review" : "To do"}{t.due ? ` · due ${new Date(`${t.due}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}` : ""}</small>
                </a>
              ))}
              <h4 className="prep-h"><Mail size={14} /> Related emails</h4>
              {p.mail === "none" && <p className="ws-muted">Connect a mailbox in Mail to see related emails here.</p>}
              {p.mail === "offline" && <p className="ws-muted">Mail couldn&apos;t be reached just now.</p>}
              {p.mail === "ok" && p.emails.length === 0 && <p className="ws-muted">No recent emails about this.</p>}
              {p.emails.map((m, i) => (
                <a key={i} className="prep-row" href={`${suite}${m.href}`}>
                  <b>{m.subject || "(no subject)"}</b>
                  <small>{m.from} · {new Date(m.date).toLocaleDateString([], { day: "numeric", month: "short" })}</small>
                  {m.snippet && <span>{m.snippet}</span>}
                </a>
              ))}
              {(p.knowledge ?? []).length > 0 && (
                <>
                  <h4 className="prep-h"><BookOpen size={14} /> Company knowledge</h4>
                  {p.knowledge!.map((k, i) =>
                    // The project's own (platform) knowledge has no article page.
                    k.href ? (
                      <a key={i} className="prep-row" href={`${suite}${k.href}`}>
                        <b>{k.title}</b>
                        {k.section && <small>{k.section}</small>}
                      </a>
                    ) : (
                      <div key={i} className="prep-row">
                        <b>{k.title}</b>
                        {k.section && <small>{k.section}</small>}
                      </div>
                    ),
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
