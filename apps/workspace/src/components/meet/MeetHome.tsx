"use client";
import { useEffect, useState } from "react";
import { CalendarDays, Copy, DoorOpen, Keyboard, Megaphone, NotebookPen, ShieldCheck, Video } from "lucide-react";
import { meetApi } from "./api";
import { checkOf, e2eeKeys, newSecret } from "./e2ee";
import ReportIntake from "./ReportIntake";

type Upcoming = { id: string; title: string; start: string; end: string; allDay: boolean; url: string | null; code: string | null };
type Mine = { code: string; title: string; host: boolean; startedAt: string | null; endedAt: string | null; createdAt: string; notes: string };

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};

/** Meet landing page (inside the suite shell). */
export default function MeetHome({ canCreate, canGuests }: { canCreate: boolean; canGuests: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [upcoming, setUpcoming] = useState<Upcoming[] | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);
  const [room, setRoom] = useState<{ code: string; url: string; passcode: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [e2ee, setE2ee] = useState(false);
  const [web, setWeb] = useState({ open: false, title: "", startsAt: "", registration: true, approval: false, panelists: "" });
  const [made, setMade] = useState<{ code: string; url: string; registerUrl?: string } | null>(null);

  useEffect(() => {
    meetApi<{ meetings: Mine[]; upcoming: Upcoming[] }>("")
      .then((d) => {
        setUpcoming(d.upcoming);
        setMine(d.meetings);
      })
      .catch(() => setUpcoming([]));
    if (canCreate) meetApi<{ meeting: { code: string; url: string; passcode: string | null } }>("/personal").then((d) => setRoom(d.meeting)).catch(() => {});
  }, [canCreate]);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      // End-to-end encryption: the key is made here and only ever travels in the link's #fragment.
      const secret = e2ee ? newSecret() : null;
      const d = await meetApi<{ meeting: { code: string } }>("", { body: { title: "", ...(secret ? { e2ee: true, e2eeCheck: await checkOf(secret) } : {}) } });
      if (secret) e2eeKeys.set(d.meeting.code, secret);
      window.location.href = `/workspace/meet/${d.meeting.code}${secret ? `#k=${secret}` : ""}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const schedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const d = await meetApi<{ meeting: { code: string; url: string; registerUrl?: string } }>("", {
        body: {
          kind: "webinar", title: web.title, startsAt: web.startsAt ? new Date(web.startsAt).toISOString() : null,
          registration: web.registration, regApproval: web.registration && web.approval,
          panelists: web.panelists.split(/[\s,;]+/).filter(Boolean),
        },
      });
      setMade(d.meeting);
      setWeb({ ...web, open: false, title: "", panelists: "" });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const m = /([a-z]{3}-?[a-z]{4}-?[a-z]{3})\s*$/i.exec(code.trim());
    if (!m) return setErr("Enter a code like abc-defg-hij, or paste the meeting link.");
    const c = m[1].toLowerCase().replace(/-/g, "");
    window.location.href = `/workspace/meet/${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}`;
  };

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div className="mt-home">
        <section className="mt-hero">
          <div>
            <h1>Meetings, right inside your workspace</h1>
            <p>
              Video calls on your own server. {canGuests ? "Share a link with anyone; people outside the organization wait until you let them in." : "For people in your organization."}
            </p>
            <div className="mt-actions">
              {canCreate && (
                <button className="mt-bigbtn" onClick={start} disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Video size={18} /> {busy ? "Starting…" : "New meeting"}
                </button>
              )}
              <form className="mt-codeform" onSubmit={go}>
                <span style={{ position: "relative", flex: 1 }}>
                  <Keyboard size={16} style={{ position: "absolute", left: 11, top: 13, color: "var(--ix-muted)" }} />
                  <input className="mt-input" style={{ paddingLeft: 34 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enter a code or link" aria-label="Meeting code or link" />
                </span>
                <button className="mt-btn" disabled={!code.trim()}>
                  Join
                </button>
              </form>
            </div>
            {canCreate && (
              <div className="mt-actions" style={{ marginTop: 10 }}>
                <label className="mt-check" title="Audio, video and screen sharing can only be decoded by people with the link. Recording, captions, AI notes, streaming and dial-in are off.">
                  <input type="checkbox" checked={e2ee} onChange={(e) => setE2ee(e.target.checked)} /> <ShieldCheck size={14} style={{ verticalAlign: -2 }} /> End-to-end encrypted
                </label>
                <button className="mt-btn sm" onClick={() => setWeb({ ...web, open: !web.open })}><Megaphone size={14} /> Schedule a webinar</button>
              </div>
            )}
            {err && <p className="mt-error">{err}</p>}
            {!canCreate && <p className="mt-note">Your role can join meetings but not start them.</p>}
            <p className="mt-note" style={{ marginTop: 10 }}>Notes for Google Meet, Zoom and Teams calls, webhooks and AI apps: <a href="/workspace/meet/integrations">Integrations</a></p>
          </div>
          <div className="mt-art" aria-hidden>
            <span>👩🏽‍💼</span>
            <span>👨🏻‍💻</span>
            <span>🧑🏾‍🔧</span>
            <span>👩🏻‍🎨</span>
          </div>
        </section>

        {canCreate && <ReportIntake />}

        {web.open && (
          <form className="mt-card" onSubmit={schedule} style={{ display: "grid", gap: 10 }}>
            <h2><Megaphone size={15} style={{ verticalAlign: -2 }} /> New webinar</h2>
            <p className="mt-note" style={{ marginTop: 0 }}>You and your panelists are on stage; up to 1000 attendees watch, raise hands, ask questions and answer polls.</p>
            <input className="mt-input" placeholder="Title" value={web.title} maxLength={200} onChange={(e) => setWeb({ ...web, title: e.target.value })} aria-label="Webinar title" />
            <label style={{ display: "grid", gap: 4 }}><span className="mt-note">Starts</span><input className="mt-input" type="datetime-local" value={web.startsAt} onChange={(e) => setWeb({ ...web, startsAt: e.target.value })} /></label>
            <label style={{ display: "grid", gap: 4 }}><span className="mt-note">Panelists (emails of people in your organization)</span><input className="mt-input" value={web.panelists} placeholder="asha@company.com, ravi@company.com" onChange={(e) => setWeb({ ...web, panelists: e.target.value })} /></label>
            <label className="mt-check"><input type="checkbox" checked={web.registration} onChange={(e) => setWeb({ ...web, registration: e.target.checked })} /> People register first (each gets their own join link by email)</label>
            {web.registration && <label className="mt-check"><input type="checkbox" checked={web.approval} onChange={(e) => setWeb({ ...web, approval: e.target.checked })} /> I approve each registration</label>}
            <div className="mt-actions"><button className="mt-btn primary" disabled={busy}>Create webinar</button><button type="button" className="mt-btn" onClick={() => setWeb({ ...web, open: false })}>Cancel</button></div>
          </form>
        )}

        {made && (
          <section className="mt-card">
            <h2>Webinar ready</h2>
            {made.registerUrl && (<p className="mt-note" style={{ marginTop: 0 }}>Share the registration page: <code className="mt-pill">{made.registerUrl}</code> <button className="mt-btn sm" onClick={() => navigator.clipboard?.writeText(made.registerUrl!).catch(() => {})}><Copy size={13} /> Copy</button></p>)}
            <div className="mt-actions"><a className="mt-btn sm primary" href={`/workspace/meet/${made.code}`}>Open the webinar</a></div>
          </section>
        )}

        {room && (
          <section className="mt-card">
            <h2><DoorOpen size={15} style={{ verticalAlign: -2 }} /> Your personal room</h2>
            <p className="mt-note" style={{ marginTop: 0 }}>One link that's always yours, for quick calls and regular meetings.</p>
            <div className="mt-actions">
              <code className="mt-pill">{room.url}</code>
              <button className="mt-btn sm" onClick={async () => { await navigator.clipboard?.writeText(room.url).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                <Copy size={13} /> {copied ? "Copied" : "Copy link"}
              </button>
              <a className="mt-btn sm primary" href={`/workspace/meet/${room.code}`}>Start</a>
            </div>
          </section>
        )}

        <section className="mt-card">
          <h2>
            <CalendarDays size={15} style={{ verticalAlign: -2 }} /> Upcoming from your calendar
          </h2>
          {upcoming === null ? (
            <p className="mt-note">Loading…</p>
          ) : upcoming.length === 0 ? (
            <p className="mt-note">
              No meetings with a video link in the next 7 days. In <a href="/workspace/calendar">Calendar</a>, turn on &ldquo;Add video meeting&rdquo; when you create an event.
            </p>
          ) : (
            <div className="mt-list">
              {upcoming.map((u) => (
                <a key={`${u.id}-${u.start}`} className="mt-row" href={u.code ? `/workspace/meet/${u.code}` : u.url ?? "#"} target={u.code ? undefined : "_blank"} rel="noreferrer">
                  <span className="when">{u.allDay ? "All day" : when(u.start)}</span>
                  <span className="t">{u.title}</span>
                  <span className="mt-btn sm">{u.code ? "Join" : "Open link"}</span>
                </a>
              ))}
            </div>
          )}
        </section>

        {mine.length > 0 && (
          <section className="mt-card">
            <h2>Recent meetings</h2>
            <div className="mt-list">
              {mine.map((m) => (
                <div key={m.code} className="mt-row">
                  <span className="when">{when(m.startedAt ?? m.createdAt)}</span>
                  <span className="t">
                    {m.title}
                    {m.host ? <span className="mt-note"> · you hosted</span> : null}
                  </span>
                  {m.startedAt && (
                    <a className="mt-btn sm" href={`/workspace/meet/${m.code}/notes`}>
                      <NotebookPen size={13} /> {m.notes === "ready" ? "Notes" : "History"}
                    </a>
                  )}
                  <a className="mt-btn sm" href={`/workspace/meet/${m.code}`}>
                    {m.endedAt || !m.startedAt ? "Open" : "Join"}
                  </a>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
