"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Mic, Pause, Play, Square, Trash2 } from "lucide-react";
import { meetApi } from "./api";
import "./report.css";

/**
 * In-person recorder (phone or desktop): MediaRecorder hands over a chunk
 * every 10 seconds and each one is uploaded straight away, in order, retried
 * until the server has it. If the tab dies, everything up to the last chunk
 * is on the server and the recording is listed here to finish later.
 */

type Unfinished = { id: string; code: string; title: string; chunks: number; bytes: number; startedAt: string };
type Phase = "idle" | "recording" | "paused" | "finishing";

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(ss).padStart(2, "0")}`;
};

function pickMime() {
  const want = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined") return "";
  return want.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export default function Recorder({ templates }: { templates: { id: string; name: string }[] }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("general");
  const [elapsed, setElapsed] = useState(0);
  const [sent, setSent] = useState(0);
  const [queued, setQueued] = useState(0);
  const [err, setErr] = useState("");
  const [level, setLevel] = useState(0);
  const [left, setLeft] = useState<Unfinished[]>([]);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const job = useRef<{ id: string; code: string; next: number } | null>(null);
  const queue = useRef<Blob[]>([]);
  const pumping = useRef(false);
  const clockRef = useRef({ acc: 0, since: 0 });
  const wake = useRef<{ release: () => Promise<void> } | null>(null);
  const stopMeter = useRef<() => void>(() => {});

  const loadLeft = useCallback(() => meetApi<{ unfinished: Unfinished[] }>("/record").then((d) => setLeft(d.unfinished)).catch(() => {}), []);
  useEffect(() => {
    loadLeft();
  }, [loadLeft]);

  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed(clockRef.current.acc + (Date.now() - clockRef.current.since)), 250);
    return () => clearInterval(t);
  }, [phase]);

  /** Upload queued chunks one at a time, in order; network errors retry every 3 s. */
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.length && job.current) {
        const j = job.current;
        const blob = queue.current[0];
        try {
          const r = await fetch(`/workspace/api/meet/record/${j.id}?seq=${j.next}`, { method: "PUT", body: blob, headers: { "content-type": "application/octet-stream" } });
          const d = await r.json().catch(() => ({}));
          if (r.ok) {
            j.next = d.next ?? j.next + 1;
            queue.current.shift();
            setSent((n) => n + 1);
            setErr("");
          } else if (r.status === 409 && typeof d.next === "number" && d.next > j.next) {
            // The server already has this one.
            j.next = d.next;
            queue.current.shift();
          } else if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
            setErr(d.error ?? `Upload failed (${r.status}).`);
            break;
          } else throw new Error(String(r.status));
        } catch {
          setErr("Connection lost. Recording continues; chunks will upload when it's back.");
          await new Promise((res) => setTimeout(res, 3000));
        }
        setQueued(queue.current.length);
      }
    } finally {
      pumping.current = false;
      setQueued(queue.current.length);
    }
  }, []);

  const start = async () => {
    setErr("");
    const mime = pickMime();
    if (!mime) return setErr("This browser can't record audio here. Try Chrome, Edge, Firefox or Safari.");
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      return setErr("Allow the microphone to record.");
    }
    try {
      const d = await meetApi<{ id: string; code: string; next: number }>("/record", { body: { action: "start", title, mime: mime.split(";")[0] } });
      job.current = { id: d.id, code: d.code, next: 0 };
      if (template !== "general") await meetApi(`/${d.code}/report`, { body: { action: "template", template } }).catch(() => {});
    } catch (e) {
      s.getTracks().forEach((t) => t.stop());
      return setErr((e as Error).message);
    }
    stream.current = s;
    const r = new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 32000 });
    r.ondataavailable = (e) => {
      if (e.data.size) {
        queue.current.push(e.data);
        setQueued(queue.current.length);
        void pump();
      }
    };
    rec.current = r;
    r.start(10_000);
    clockRef.current = { acc: 0, since: Date.now() };
    setElapsed(0);
    setSent(0);
    setPhase("recording");
    try {
      wake.current = await (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null;
    } catch {}
    // Input level, so people can see the mic is hearing them.
    try {
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let raf = 0;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
        raf = requestAnimationFrame(tick);
      };
      tick();
      stopMeter.current = () => {
        cancelAnimationFrame(raf);
        ctx.close().catch(() => {});
      };
    } catch {}
  };

  const pause = () => {
    const r = rec.current;
    if (!r) return;
    if (phase === "recording") {
      r.pause();
      clockRef.current.acc += Date.now() - clockRef.current.since;
      setElapsed(clockRef.current.acc);
      setPhase("paused");
    } else if (phase === "paused") {
      r.resume();
      clockRef.current.since = Date.now();
      setPhase("recording");
    }
  };

  const finish = async () => {
    const r = rec.current;
    const j = job.current;
    if (!r || !j) return;
    setPhase("finishing");
    await new Promise<void>((res) => {
      r.onstop = () => res();
      r.stop();
    });
    stream.current?.getTracks().forEach((t) => t.stop());
    stopMeter.current();
    wake.current?.release().catch(() => {});
    // Wait for every chunk to reach the server.
    for (let i = 0; i < 600 && (queue.current.length || pumping.current); i++) {
      void pump();
      await new Promise((res) => setTimeout(res, 500));
    }
    try {
      const d = await meetApi<{ code: string }>("/record", { body: { action: "finish", id: j.id, title } });
      window.location.href = `/workspace/meet/${d.code}/notes`;
    } catch (e) {
      setErr((e as Error).message);
      setPhase("idle");
      loadLeft();
    }
  };

  // Leaving mid-recording: the server keeps what arrived; it shows up below to finish.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (phase === "recording" || phase === "paused" || phase === "finishing") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const finishOld = async (u: Unfinished) => {
    try {
      const d = await meetApi<{ code: string }>("/record", { body: { action: "finish", id: u.id } });
      window.location.href = `/workspace/meet/${d.code}/notes`;
    } catch (e) {
      setErr((e as Error).message);
      loadLeft();
    }
  };
  const discardOld = async (u: Unfinished) => {
    await meetApi("/record", { body: { action: "discard", id: u.id } }).catch((e) => setErr((e as Error).message));
    loadLeft();
  };

  const active = phase !== "idle";
  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div className="mt-recorder">
        <a className="mt-btn sm" href="/workspace/meet" style={{ width: "fit-content" }}><ArrowLeft size={13} /> Meet</a>
        <div>
          <h1 style={{ font: "400 28px var(--font-serif), Georgia, serif", margin: 0 }}>Record in person</h1>
          <p className="mt-note" style={{ marginTop: 4 }}>Put your phone or laptop on the table. Audio uploads every 10 seconds while you record; when you stop, you get a report with speakers, chapters and action items. Tell people they're being recorded.</p>
        </div>
        <div className="mt-card" style={{ display: "grid", gap: 10 }}>
          <input className="mt-input" placeholder="Title (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-label="Meeting title" disabled={phase === "finishing"} />
          <label style={{ display: "grid", gap: 4 }}>
            <span className="mt-note">Report template</span>
            <select className="mt-select" value={template} onChange={(e) => setTemplate(e.target.value)} disabled={active} aria-label="Report template">
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-card mt-rec-face">
          <div className="mt-rec-time" aria-live="off">{clock(elapsed)}</div>
          {active && <div className="mt-level" aria-hidden><i style={{ width: `${Math.round(level * 100)}%` }} /></div>}
          <p className="mt-note" style={{ margin: 0 }} role="status">
            {phase === "idle" ? "Ready" : phase === "paused" ? "Paused" : phase === "finishing" ? "Finishing…" : "Recording"}
            {active ? ` · ${sent} chunk${sent === 1 ? "" : "s"} uploaded${queued ? `, ${queued} waiting` : ""}` : ""}
          </p>
          {!active ? (
            <button className="mt-rec-btn" onClick={start} aria-label="Start recording"><Mic size={34} /></button>
          ) : (
            <div className="mt-rec-row">
              <button className="mt-btn" onClick={pause} disabled={phase === "finishing"}>{phase === "paused" ? <><Play size={15} /> Resume</> : <><Pause size={15} /> Pause</>}</button>
              <button className="mt-btn primary" onClick={finish} disabled={phase === "finishing"}><Square size={14} /> {phase === "finishing" ? "Uploading the rest…" : "Stop and make the report"}</button>
            </div>
          )}
          {err && <p className="mt-error" style={{ margin: 0, textAlign: "center" }}>{err}</p>}
        </div>
        {left.length > 0 && !active && (
          <section className="mt-card">
            <h2>Unfinished recordings</h2>
            <p className="mt-note" style={{ marginTop: 0 }}>These stopped before they were finished (the tab closed or the phone slept). What was uploaded is kept.</p>
            <div className="mt-list">
              {left.map((u) => (
                <div key={u.id} className="mt-row">
                  <span className="t" style={{ flex: 1, minWidth: 0 }}>{u.title}<span className="mt-note"> · {new Date(u.startedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · about {clock(u.chunks * 10_000)}</span></span>
                  <button className="mt-btn sm primary" onClick={() => finishOld(u)} disabled={!u.chunks}>Finish</button>
                  <button className="mt-iconbtn" aria-label="Discard" title="Discard" onClick={() => discardOld(u)}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
