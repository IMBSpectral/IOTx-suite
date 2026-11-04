"use client";
import { useEffect, useRef, useState } from "react";
import { FileAudio, LayoutTemplate, Mic, Upload } from "lucide-react";

/**
 * Meet home: get a report from a conversation that wasn't a Meet call.
 * Upload a recording (sent as the raw file, streamed to disk on the server,
 * with progress) or record in person. Hidden for roles without AI notes.
 */
export default function ReportIntake() {
  const [ok, setOk] = useState(false);
  const [left, setLeft] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const xhr = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    // Only people who may add meetings with AI notes see this.
    fetch("/workspace/api/meet/record", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        setOk(true);
        const d = await r.json().catch(() => ({}));
        setLeft((d.unfinished ?? []).length);
      })
      .catch(() => {});
  }, []);
  if (!ok) return null;

  const upload = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    if (file.size > 2 * 1024 ** 3) return setErr("Files can be up to 2 GB.");
    setErr("");
    const q = new URLSearchParams({ title: title.trim() || file.name.replace(/\.[^.]+$/, ""), name: file.name });
    if (date) q.set("date", new Date(date).toISOString());
    const x = new XMLHttpRequest();
    xhr.current = x;
    x.open("POST", `/workspace/api/meet/upload?${q}`);
    x.setRequestHeader("content-type", file.type || "application/octet-stream");
    x.upload.onprogress = (ev) => ev.lengthComputable && setPct(Math.round((ev.loaded / ev.total) * 100));
    x.onload = () => {
      let d: { code?: string; error?: string } = {};
      try {
        d = JSON.parse(x.responseText);
      } catch {}
      if (x.status === 201 && d.code) window.location.href = `/workspace/meet/${d.code}/notes`;
      else {
        setPct(null);
        setErr(d.error ?? `Upload failed (${x.status}).`);
      }
    };
    x.onerror = () => {
      setPct(null);
      setErr("The upload was interrupted. Check the connection and try again.");
    };
    setPct(0);
    x.send(file);
  };

  return (
    <section className="mt-card" style={{ display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0 }}><FileAudio size={15} style={{ verticalAlign: -2 }} /> Reports from any conversation</h2>
      <p className="mt-note" style={{ margin: 0 }}>Upload a recording, or record a meeting in the room, and get the same report as a Meet call: summary, chapters, action items, speakers and scores.</p>
      <form onSubmit={upload} style={{ display: "grid", gap: 8 }}>
        <input className="mt-input" type="file" accept="audio/*,video/*,.mp3,.m4a,.wav,.ogg,.webm,.mp4,.mov,.mkv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(""); }} aria-label="Recording file" disabled={pct !== null} />
        {file && (
          <div className="mt-actions">
            <input className="mt-input" style={{ flex: "2 1 200px" }} placeholder={file.name.replace(/\.[^.]+$/, "")} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-label="Title" disabled={pct !== null} />
            <input className="mt-input" style={{ flex: "1 1 160px" }} type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} aria-label="When it happened" disabled={pct !== null} />
          </div>
        )}
        <div className="mt-actions">
          <button className="mt-btn primary" disabled={!file || pct !== null}><Upload size={14} /> {pct === null ? "Upload and make a report" : `Uploading… ${pct}%`}</button>
          {pct !== null && <button type="button" className="mt-btn" onClick={() => { xhr.current?.abort(); setPct(null); }}>Cancel</button>}
          <a className="mt-btn" href="/workspace/meet/record"><Mic size={14} /> Record in person{left ? ` (${left} unfinished)` : ""}</a>
          <a className="mt-btn sm" href="/workspace/meet/report-settings"><LayoutTemplate size={13} /> Templates and vocabulary</a>
        </div>
        {err && <p className="mt-error" style={{ margin: 0 }}>{err}</p>}
        <p className="mt-note" style={{ margin: 0 }}>Audio or video up to 2 GB. Let people know before you record them.</p>
      </form>
    </section>
  );
}
