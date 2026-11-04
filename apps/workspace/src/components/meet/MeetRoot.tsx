"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Lock, ShieldCheck } from "lucide-react";
import PreJoin, { type Choices } from "./PreJoin";
import { guestKey, meetApi, MeetError, type JoinReply, type MeetingInfo } from "./api";
import { checkOf, e2eeKeys, newSecret, parseSecret, secretFromHash } from "./e2ee";

/** Insertable streams (Chrome, Edge, Firefox 117+) or RTCRtpScriptTransform (Safari 15.4+). */
const e2eeSupported = () =>
  typeof window !== "undefined" && typeof RTCRtpSender !== "undefined" && ("createEncodedStreams" in RTCRtpSender.prototype || "RTCRtpScriptTransform" in window);

const RoomView = dynamic(() => import("./RoomView"), { ssr: false, loading: () => <Center title="Connecting…" spin /> });

type Admitted = Extract<JoinReply, { status: "admitted" }> & { room?: number; roomName?: string };
type Phase =
  | { k: "prejoin" }
  | { k: "waiting"; key: string }
  | { k: "room"; join: Admitted; n: number }
  | { k: "left"; why: "left" | "removed" | "ended" | "denied" | "error"; message?: string };

function Center({ title, text, spin, children }: { title: string; text?: string; spin?: boolean; children?: React.ReactNode }) {
  return (
    <div className="mt-root mt-dark">
      <div className="mt-center">
        {spin && <div className="ws-spinner" aria-hidden />}
        <h1>{title}</h1>
        {text && <p>{text}</p>}
        {children}
      </div>
    </div>
  );
}

/** The meeting page: pre-join, the waiting room (guests), the room, and after. */
export default function MeetRoot({ info: initial, signInUrl }: { info: MeetingInfo; signInUrl: string }) {
  const [info, setInfo] = useState(initial);
  const member = !!info.you;
  const [phase, setPhase] = useState<Phase>({ k: "prejoin" });
  const [name, setName] = useState(info.you?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [reg, setReg] = useState("");
  // End-to-end encryption: the key (from the link's #k=…, this browser, or typed in).
  const [secret, setSecret] = useState<string | null>(null);
  const [keyText, setKeyText] = useState("");
  const [keyErr, setKeyErr] = useState("");
  // Checked after hydration (the server can't know the browser).
  const [canE2ee, setCanE2ee] = useState(true);
  useEffect(() => setCanE2ee(e2eeSupported()), []);
  const webinar = info.kind === "webinar";
  // Webinar attendees watch only: no camera or microphone check.
  const viewOnly = webinar && !(info.you && (info.you.host || info.you.coHost || info.you.panelist));
  const choices = useRef<Choices>(viewOnly ? { video: false, audio: false } : { video: true, audio: !info.muteOnEntry });

  useEffect(() => {
    setHasKey(!member && !!guestKey.get(info.code));
    // An invite link may carry the passcode (?p=…); a webinar registrant's link carries ?r=….
    const q = new URLSearchParams(window.location.search);
    if (q.get("p")) setPasscode(q.get("p")!);
    if (q.get("r")) setReg(q.get("r")!);
    try {
      if (!member) setName(localStorage.getItem("iotx-meet-name") ?? "");
    } catch {}
  }, [info.code, member]);

  // The key: from the link (then hidden from the address bar), or remembered by this browser; checked against the meeting.
  useEffect(() => {
    const fromLink = secretFromHash();
    if (!info.e2ee || !info.e2eeCheck) return;
    const s = fromLink ?? e2eeKeys.get(info.code);
    if (!s) return;
    checkOf(s).then((c) => {
      if (c === info.e2eeCheck) {
        e2eeKeys.set(info.code, s);
        setSecret(s);
      } else if (fromLink) setKeyErr("The key in this link doesn't match this meeting. Ask the host for the latest link.");
    });
  }, [info.code, info.e2ee, info.e2eeCheck]);

  const tryKey = async (text: string) => {
    setKeyText(text);
    setKeyErr("");
    const s = parseSecret(text);
    if (!s) return;
    if ((await checkOf(s)) !== info.e2eeCheck) return setKeyErr("That key doesn't match this meeting.");
    e2eeKeys.set(info.code, s);
    setSecret(s);
  };

  // The host turns encryption on or off before anyone joins.
  const setE2ee = async (on: boolean) => {
    setErr("");
    setBusy(true);
    try {
      if (on) {
        const s = newSecret();
        const check = await checkOf(s);
        await meetApi(`/${info.code}`, { method: "PATCH", body: { e2ee: true, e2eeCheck: check } });
        e2eeKeys.set(info.code, s);
        setSecret(s);
        setInfo({ ...info, e2ee: true, e2eeCheck: check });
      } else {
        await meetApi(`/${info.code}`, { method: "PATCH", body: { e2ee: false } });
        e2eeKeys.clear(info.code);
        setSecret(null);
        setInfo({ ...info, e2ee: false, e2eeCheck: null });
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handle = (r: JoinReply) => {
    if (r.key) guestKey.set(info.code, r.key);
    if (r.status === "admitted") setPhase({ k: "room", join: r, n: Date.now() });
    else setPhase({ k: "waiting", key: member ? "" : r.key ?? guestKey.get(info.code) ?? "" });
  };

  const fail = (e: unknown) => {
    const me = e as MeetError;
    const status = String(me.data?.status ?? "");
    if (status === "denied") {
      guestKey.clear(info.code);
      setPhase({ k: "left", why: "denied" });
    } else if (status === "removed") setPhase({ k: "left", why: "removed" });
    else if (status === "unknown") {
      guestKey.clear(info.code);
      setHasKey(false);
      setErr("Your earlier request has expired. Ask to join again.");
    } else setErr(me.message || "Couldn't join.");
  };

  const join = async () => {
    if (info.e2ee && !secret) return setErr("Enter the encryption key first.");
    setBusy(true);
    setErr("");
    try {
      if (member) handle(await meetApi<JoinReply>(`/${info.code}/join`, { body: {} }));
      else if (reg && !guestKey.get(info.code)) handle(await meetApi<JoinReply>(`/${info.code}/join`, { body: { reg } }));
      else {
        const key = guestKey.get(info.code);
        if (!key) {
          if (!name.trim()) {
            setErr("Enter your name.");
            return;
          }
          try {
            localStorage.setItem("iotx-meet-name", name.trim());
          } catch {}
        }
        handle(await meetApi<JoinReply>(`/${info.code}/join`, { body: key ? { key } : { name: name.trim(), passcode: passcode.trim() || undefined } }));
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Waiting room: check back every 2.5 s.
  useEffect(() => {
    if (phase.k !== "waiting") return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const r = await meetApi<JoinReply>(`/${info.code}/join`, { body: member ? {} : { key: phase.key } });
        if (!stop && r.status === "admitted") handle(r);
      } catch (e) {
        if (!stop) {
          fail(e);
          if (!["denied", "removed"].includes(String((e as MeetError).data?.status))) setPhase({ k: "prejoin" });
        }
      }
    }, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase.k === "room")
    return (
      <RoomView
        key={phase.n}
        info={info}
        join={phase.join}
        onSwitch={(j) => setPhase({ k: "room", join: j, n: Date.now() })}
        choices={choices.current}
        secret={info.e2ee ? secret : null}
        guest={member ? null : guestKey.get(info.code)}
        onLeave={(why, message) => setPhase({ k: "left", why, message })}
      />
    );

  if (phase.k === "waiting")
    return (
      <Center title="Waiting for the host to let you in" text={`You asked to join "${info.title}". Stay on this page; you'll join as soon as someone admits you.`} spin>
        <button
          className="mt-btn"
          onClick={() => {
            if (!member) guestKey.clear(info.code);
            setHasKey(false);
            setPhase({ k: "prejoin" });
          }}
        >
          Cancel
        </button>
      </Center>
    );

  if (phase.k === "left") {
    const t = {
      left: ["You left the meeting", ""],
      removed: ["The host removed you from this meeting", ""],
      ended: ["The meeting has ended", ""],
      denied: ["The host didn't let you in", "You can ask to join again if you think this was a mistake."],
      error: ["You were disconnected", phase.message ?? "Check your connection and rejoin."],
    }[phase.why];
    return (
      <Center title={t[0]} text={t[1]}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {phase.why !== "removed" && (
            <button className="mt-btn primary" onClick={() => setPhase({ k: "prejoin" })}>
              {phase.why === "denied" ? "Ask again" : "Rejoin"}
            </button>
          )}
          {member && (
            <a className="mt-btn" href="/workspace/meet">
              Back to Meet
            </a>
          )}
          {member && (
            <a className="mt-btn" href={`/workspace/meet/${info.code}/notes`}>
              Meeting notes
            </a>
          )}
        </div>
      </Center>
    );
  }

  const membersOnly = !member && !info.allowGuests;
  // Webinars with registration: guests need their emailed link (or register first).
  const mustRegister = webinar && !!info.registration && !member && !reg && !hasKey;
  const needKey = !!info.e2ee && !secret;
  const noun = webinar ? "webinar" : "meeting";
  const card = (
    <div className="mt-join">
      <h1>{info.title}</h1>
      <p className="sub">
        {webinar ? "Webinar hosted by" : "Hosted by"} {info.host}
        {info.locked && (
          <>
            {" · "}
            <Lock size={12} style={{ verticalAlign: -1 }} /> Locked
          </>
        )}
      </p>
      {webinar && info.startsAt && <p className="mt-note" style={{ margin: 0 }}>Starts {new Date(info.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>}
      {viewOnly && <p className="mt-note" style={{ margin: 0 }}>You&apos;ll watch and listen. Raise your hand if you want to speak, and ask questions in Q&amp;A.</p>}
      {info.ended && !info.you?.host && <p className="mt-note">This {noun} has ended. It opens again when the host rejoins.</p>}
      {info.e2ee && (
        <div className="mt-e2ee-box">
          <p style={{ margin: 0 }}><ShieldCheck size={14} style={{ verticalAlign: -2 }} /> <b>End-to-end encrypted.</b> Audio, video and screen sharing can only be decoded by people with the key.</p>
          {!canE2ee && <p className="mt-error" style={{ margin: 0 }}>This browser can&apos;t join encrypted meetings. Use a current Chrome, Edge, Firefox or Safari.</p>}
          {needKey && (
            <label style={{ display: "grid", gap: 6 }}>
              <span className="mt-note">Encryption key</span>
              <input className="mt-input" value={keyText} autoComplete="off" spellCheck={false} placeholder="Paste the invite link or the key" onChange={(e) => tryKey(e.target.value)} aria-label="Encryption key" />
            </label>
          )}
          {keyErr && <p className="mt-error" style={{ margin: 0 }}>{keyErr}</p>}
        </div>
      )}
      {info.you?.host && !webinar && (
        <label className="mt-check">
          <input type="checkbox" checked={!!info.e2ee} disabled={busy} onChange={(e) => setE2ee(e.target.checked)} /> End-to-end encryption
          <span className="mt-note" style={{ display: "block", fontSize: 12 }}>Turns off recording, captions, AI notes, live streaming and phone dial-in. Chat, polls, Q&amp;A and the whiteboard still go through the server.</span>
        </label>
      )}
      {member ? (
        <>
          <p className="mt-note">
            Joining as <b>{info.you!.name}</b>
            {info.you!.host ? " (host)" : info.you!.coHost ? " (co-host)" : info.you!.panelist ? " (panelist)" : viewOnly ? " (attendee)" : ""}
          </p>
          <button className="mt-bigbtn" onClick={join} disabled={busy || needKey}>
            {busy ? "Joining…" : "Join now"}
          </button>
        </>
      ) : membersOnly ? (
        <>
          <p>This {noun} is for people in the organization.</p>
          <a className="mt-bigbtn" href={signInUrl} style={{ textAlign: "center", textDecoration: "none" }}>
            Sign in to join
          </a>
        </>
      ) : mustRegister ? (
        <>
          <p>Register to get your personal join link by email.</p>
          <a className="mt-bigbtn" href={`/workspace/meet/${info.code}/register`} style={{ textAlign: "center", textDecoration: "none" }}>
            Register
          </a>
          <p className="mt-note">
            Already registered? Open the link from your email. In the organization?{" "}
            <a href={signInUrl} className="mt-link">Sign in</a>
          </p>
        </>
      ) : reg && !hasKey ? (
        <>
          <p className="mt-note">You&apos;re joining with your registration link.</p>
          <button className="mt-bigbtn" onClick={join} disabled={busy}>
            {busy ? "Joining…" : "Join webinar"}
          </button>
        </>
      ) : (
        <>
          {hasKey ? (
            <p className="mt-note">You already asked to join from this tab.</p>
          ) : (
            <>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="mt-note">Your name</span>
                <input
                  className="mt-input"
                  value={name}
                  maxLength={60}
                  autoComplete="name"
                  placeholder="e.g. Priya Sharma"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && join()}
                />
              </label>
              {info.passcode && (
                <label style={{ display: "grid", gap: 6 }}>
                  <span className="mt-note">Passcode</span>
                  <input className="mt-input" value={passcode} maxLength={10} autoComplete="off" placeholder="From your invitation" onChange={(e) => setPasscode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && join()} />
                </label>
              )}
            </>
          )}
          <button className="mt-bigbtn" onClick={join} disabled={busy || needKey || (!hasKey && (!name.trim() || (!!info.passcode && !passcode.trim())))}>
            {busy ? "Asking…" : hasKey ? "Continue" : info.waitingRoom && !webinar ? "Ask to join" : "Join now"}
          </button>
          <p className="mt-note">
            {info.waitingRoom && !webinar ? "The host will let you in. " : ""}
            In the organization?{" "}
            <a href={signInUrl} className="mt-link">
              Sign in instead
            </a>
          </p>
        </>
      )}
      {err && <p className="mt-error">{err}</p>}
    </div>
  );
  return (
    <div className="mt-root mt-dark">
      <div className="mt-pre-top">
        <a className="mt-brand" href={member ? "/workspace/meet" : undefined}>
          <span className="mt-mark">IX</span> Meet
        </a>
      </div>
      {viewOnly ? (
        <div className="mt-pre mt-pre-solo">{card}</div>
      ) : (
        <PreJoin name={name} defaultAudio={!info.muteOnEntry || !!info.you?.host} onChange={(c) => (choices.current = c)}>
          {card}
        </PreJoin>
      )}
    </div>
  );
}
