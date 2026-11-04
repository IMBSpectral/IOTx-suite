"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, Hand, Phone, Radio, ShieldCheck, UserCheck, UserMinus, UserX } from "lucide-react";
import { colorFor, initials, meetApi, type DialIn } from "./api";
import type { Ctx } from "./Panels";

/** Webinar hosts: the audience (raised hands first), the stage, registrations and settings. */
type Person = { identity: string; name: string; kind: string; role: string; hand: string | null; registered: boolean };
type Registrant = { id: string; name: string; email: string; company: string; status: string; emailedAt: string | null; joinedAt: string | null };

export function WebinarPanel({ ctx, bump, settings, onSettings }: {
  ctx: Ctx; bump: number;
  settings: { registration?: boolean; regApproval?: boolean } | null;
  onSettings: (patch: Record<string, unknown>) => void;
}) {
  const [aud, setAud] = useState<{ attendees: Person[]; stage: Person[]; count: number; cap: number } | null>(null);
  const [regs, setRegs] = useState<Registrant[]>([]);
  const [link, setLink] = useState("");
  const [tab, setTab] = useState<"audience" | "registrations">("audience");
  const load = useCallback(async () => {
    try {
      setAud(await meetApi(`/${ctx.code}/stage`, { guest: ctx.guest }));
      if (settings?.registration) {
        const r = await meetApi<{ registrants: Registrant[]; link: string }>(`/${ctx.code}/registrants`, { guest: ctx.guest });
        setRegs(r.registrants);
        setLink(r.link);
      }
    } catch (e) {
      ctx.toast((e as Error).message);
    }
  }, [ctx, settings?.registration]);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load, bump]);
  const stage = async (identity: string, on: boolean) => {
    await meetApi(`/${ctx.code}/stage`, { body: { identity, on }, guest: ctx.guest }).catch((e) => ctx.toast(e.message));
    load();
  };
  const reg = async (action: string, id: string) => {
    const r = await meetApi<{ emailed: number }>(`/${ctx.code}/registrants`, { body: { action, id }, guest: ctx.guest }).catch((e) => (ctx.toast(e.message), null));
    if (r && (action === "approve" || action === "resend")) ctx.toast(r.emailed ? "Join link emailed." : "Saved, but the email couldn't be sent.");
    load();
  };
  const row = (p: Person, onStage: boolean) => (
    <div key={p.identity} className="mt-person">
      <span className="mt-avatar" style={{ background: colorFor(p.identity) }}>{initials(p.name)}</span>
      <div className="who"><b>{p.name}</b><span>{p.hand ? "✋ Hand raised · " : ""}{p.registered ? "Registered" : p.kind === "member" ? "Member" : "Guest"}</span></div>
      {onStage
        ? <button className="mt-btn sm" onClick={() => stage(p.identity, false)} title="Back to the audience"><UserMinus size={14} /> Audience</button>
        : <button className={`mt-btn sm${p.hand ? " primary" : ""}`} onClick={() => stage(p.identity, true)} title="They may turn on their mic and camera"><UserCheck size={14} /> On stage</button>}
    </div>
  );
  const pending = regs.filter((r) => r.status === "pending");
  return (
    <div className="mt-side-body">
      <div className="row" style={{ display: "flex", gap: 6 }}>
        <button className={`mt-btn sm${tab === "audience" ? " primary" : ""}`} onClick={() => setTab("audience")}>Audience{aud ? ` (${aud.attendees.length})` : ""}</button>
        {settings?.registration && <button className={`mt-btn sm${tab === "registrations" ? " primary" : ""}`} onClick={() => setTab("registrations")}>Registrations{pending.length ? ` (${pending.length} waiting)` : ""}</button>}
      </div>
      {tab === "audience" && (
        <>
          {aud && <p className="mt-note">{aud.count} in the webinar · up to {aud.cap}</p>}
          <div className="mt-sect">On stage ({aud?.stage.length ?? 0})</div>
          {aud?.stage.length ? aud.stage.map((p) => row(p, true)) : <p className="mt-note">Hosts and invited panelists are on stage. Bring people up from the audience below.</p>}
          <div className="mt-sect"><Hand size={13} /> Audience</div>
          {aud?.attendees.length ? aud.attendees.slice(0, 300).map((p) => row(p, false)) : <p className="mt-note">Nobody is watching yet.</p>}
          <div className="mt-sect">Settings</div>
          <label className="mt-check"><input type="checkbox" checked={!!settings?.registration} onChange={(e) => onSettings({ registration: e.target.checked })} /> People register first</label>
          {settings?.registration && <label className="mt-check"><input type="checkbox" checked={!!settings?.regApproval} onChange={(e) => onSettings({ regApproval: e.target.checked })} /> I approve each registration</label>}
        </>
      )}
      {tab === "registrations" && (
        <>
          {link && (
            <div className="row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <code className="mt-pill" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{link}</code>
              <button className="mt-iconbtn" onClick={() => navigator.clipboard?.writeText(link).then(() => ctx.toast("Registration link copied."))} aria-label="Copy registration link"><Copy size={15} /></button>
            </div>
          )}
          {regs.length === 0 && <p className="mt-note">No registrations yet.</p>}
          {regs.map((r) => (
            <div key={r.id} className="mt-person">
              <div className="who"><b>{r.name}</b><span>{r.email}{r.company ? ` · ${r.company}` : ""} · {r.status === "pending" ? "Waiting" : r.status === "approved" ? (r.joinedAt ? "Joined" : "Approved") : "Declined"}</span></div>
              {r.status !== "approved" && <button className="mt-btn sm primary" onClick={() => reg("approve", r.id)}>Approve</button>}
              {r.status === "approved" && <button className="mt-btn sm" onClick={() => reg("resend", r.id)} title="Email a new link (the old one stops working)">Resend</button>}
              {r.status !== "denied" && <button className="mt-iconbtn" onClick={() => reg("deny", r.id)} aria-label={`Decline ${r.name}`}><UserX size={15} /></button>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** Live streaming to an RTMP address (YouTube Live, Facebook, a CDN). The stream key is never stored. */
export function StreamPanel({ ctx, canStream }: { ctx: Ctx; canStream: boolean }) {
  const [st, setSt] = useState<{ enabled: boolean; streams: { id: string; target: string; status: string; error: string; startedAt: string }[] } | null>(null);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => meetApi(`/${ctx.code}/stream`, { guest: ctx.guest }).then(setSt).catch((e) => setErr(e.message)), [ctx.code, ctx.guest]);
  useEffect(() => {
    if (!canStream) return;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, canStream]);
  if (!canStream) return <div className="mt-side-body"><p className="mt-note">Live streaming needs the host, and the recording switch from your admin.</p></div>;
  const live = st?.streams.filter((s) => ["starting", "active"].includes(s.status)) ?? [];
  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await meetApi(`/${ctx.code}/stream`, { body, guest: ctx.guest });
      if (body.action === "start") setKey("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-side-body">
      {st && !st.enabled && <p className="mt-note">Live streaming isn&apos;t available here (it&apos;s off on this server, or the meeting is end-to-end encrypted).</p>}
      {live.map((s) => (
        <div key={s.id} className="mt-person">
          <Radio size={16} color={s.status === "active" ? "#e5484d" : undefined} />
          <div className="who"><b>{s.status === "active" ? "Live" : "Starting…"}</b><span>{s.target}</span></div>
          <button className="mt-btn sm" disabled={busy} onClick={() => act({ action: "stop", id: s.id })}>Stop</button>
        </div>
      ))}
      <label style={{ display: "grid", gap: 4 }}>
        <span className="mt-note">Server address (RTMP)</span>
        <input className="mt-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtmp://a.rtmp.youtube.com/live2" autoComplete="off" />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="mt-note">Stream key</span>
        <input className="mt-input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="From your streaming service" autoComplete="off" />
      </label>
      <button className="mt-btn primary" disabled={busy || !url.trim() || !st?.enabled} onClick={() => act({ action: "start", url, key })}><Radio size={14} /> {busy ? "Starting…" : "Go live"}</button>
      <p className="mt-note">Everyone in the meeting sees that it&apos;s live. The stream shows the active speaker and screen shares.</p>
      {err && <p className="mt-error">{err}</p>}
      {st && st.streams.filter((s) => !["starting", "active"].includes(s.status)).slice(0, 5).map((s) => (
        <p key={s.id} className="mt-note" style={{ margin: 0 }}>{new Date(s.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {s.target} · {s.status}{s.error ? ` (${s.error.slice(0, 120)})` : ""}</p>
      ))}
    </div>
  );
}

/** Meeting information: the link, the passcode (hosts), dial-in, encryption. */
export function InfoPanel({ ctx, link, passcode, dialIn, encrypted, invite }: { ctx: Ctx; link: string; passcode: string | null; dialIn: DialIn | null | undefined; encrypted: boolean; invite: string }) {
  const copy = (t: string, what: string) => navigator.clipboard?.writeText(t).then(() => ctx.toast(`${what} copied.`)).catch(() => ctx.toast(t));
  return (
    <div className="mt-side-body">
      <div className="mt-sect" style={{ marginTop: 0 }}>Link</div>
      <div className="row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <code className="mt-pill" style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{link.replace(/#k=.*/, "#k=…")}</code>
        <button className="mt-iconbtn" onClick={() => copy(link, "Link")} aria-label="Copy link"><Copy size={15} /></button>
      </div>
      {passcode && <p className="mt-note">Passcode for guests: <b>{passcode}</b></p>}
      {encrypted && <p className="mt-note"><ShieldCheck size={13} style={{ verticalAlign: -2 }} /> End-to-end encrypted. The key is in the link after #k= and never reaches the server, so share the link only with people you invite. Recording, captions, AI notes, live streaming and dial-in are off. Chat, polls, Q&amp;A and the whiteboard still go through the server.</p>}
      <div className="mt-sect"><Phone size={13} /> Join by phone</div>
      {dialIn ? (
        <div className="mt-dialin">
          {dialIn.numbers.map((n, i) => <a key={n} href={`tel:${dialIn.oneTap[i]}`}><code>{n}</code></a>)}
          <span>Meeting ID: <code>{dialIn.meetingId}</code></span>
          <span>PIN: <code>{dialIn.pin}</code></span>
          <span className="mt-note">Dial, enter the meeting ID and the PIN, then press #.</span>
        </div>
      ) : (
        <p className="mt-note">{encrypted ? "Phones can't join encrypted meetings." : "Phone dial-in isn't set up on this server."}</p>
      )}
      <button className="mt-btn" onClick={() => copy(invite, "Invitation")}><Copy size={14} /> Copy invitation</button>
    </div>
  );
}

/** Invitation text: link, passcode, phone. */
export function inviteText(title: string, link: string, passcode: string | null, dialIn: DialIn | null | undefined) {
  return [
    `Join "${title}"`,
    link,
    ...(passcode ? [`Passcode: ${passcode}`] : []),
    ...(dialIn ? ["", "Join by phone:", ...dialIn.numbers.map((n) => `  ${n}`), `Meeting ID: ${dialIn.meetingId}`, `PIN: ${dialIn.pin}`] : []),
  ].join("\n");
}
