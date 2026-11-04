"use client";
import { useEffect, useState } from "react";

/**
 * Public page for people outside the workspace: "don't summarise me" in
 * meetings. They give the meeting link or code they were invited with and
 * their email, then confirm from the email. With ?t= it confirms.
 */
export default function OptOut() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<"form" | "sent" | "confirming" | "done" | "error">("form");
  const [f, setF] = useState({ code: "", email: "", name: "" });
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("t");
    if (q.get("code")) setF((x) => ({ ...x, code: q.get("code")! }));
    if (!t) return;
    setToken(t);
    setState("confirming");
    fetch("/workspace/api/meet/read/optout/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok) setState("done");
        else { setMsg(d.error ?? "This link isn't valid."); setState("error"); }
      })
      .catch(() => { setMsg("Couldn't reach the server."); setState("error"); });
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const code = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(f.code)?.[1] ?? f.code.trim();
    const r = await fetch("/workspace/api/meet/read/optout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, code }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) setState("sent");
    else setMsg(d.error ?? "Something went wrong.");
  };
  return (
    <div className="mt-root" style={{ position: "fixed", inset: 0, overflow: "auto" }}>
      <div className="mt-center" style={{ maxWidth: 460, margin: "0 auto", padding: "48px 20px", display: "grid", gap: 14 }}>
        <h1>Don&rsquo;t summarise me</h1>
        {state === "form" && (
          <form onSubmit={submit} style={{ display: "grid", gap: 10, textAlign: "left" }}>
            <p className="mt-note" style={{ fontSize: 14 }}>Meetings in this workspace can be transcribed and summarised by AI. Ask to be left out: what you say won&rsquo;t appear in transcripts or reports of meetings you attend. We&rsquo;ll email you a link to confirm.</p>
            <input className="mt-input" placeholder="Meeting link or code you were invited with" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} aria-label="Meeting link or code" required />
            <input className="mt-input" placeholder="Your name (as you join meetings)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Your name" maxLength={120} />
            <input className="mt-input" type="email" placeholder="Your email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="Your email" required />
            <button className="mt-bigbtn">Send confirmation</button>
            {msg && <p className="mt-error">{msg}</p>}
          </form>
        )}
        {state === "sent" && <p>Check your email and open the link to confirm.</p>}
        {state === "confirming" && token && <p>Confirming…</p>}
        {state === "done" && <p>Done. You won&rsquo;t be included in transcripts or reports of this workspace&rsquo;s meetings from now on.</p>}
        {state === "error" && <p className="mt-error">{msg}</p>}
      </div>
    </div>
  );
}
