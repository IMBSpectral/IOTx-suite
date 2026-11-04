"use client";

import { useRef, useState } from "react";
import { Search } from "lucide-react";
import { searchHelp } from "@/lib/help";

/** Help articles with search, and a contact form that carries its own context. */
export default function HelpCenter({
  initialQuery,
  projects,
}: {
  initialQuery: string;
  projects: { id: string; name: string }[];
}) {
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ subject: "", message: "", projectId: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" | "error"; text?: string }>({ kind: "idle" });
  const fileRef = useRef<HTMLInputElement>(null);
  const results = searchHelp(q);
  const muted = { color: "var(--muted)" };

  async function send() {
    setState({ kind: "sending" });
    const body = new FormData();
    body.append("subject", form.subject);
    body.append("message", form.message);
    if (form.projectId) body.append("projectId", form.projectId);
    for (const f of files) body.append("files", f);
    const res = await fetch("/api/support", { method: "POST", body });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setState({ kind: "error", text: d.error ?? "Couldn't send your message." });
    setState({ kind: "sent", text: d.id });
    setForm({ subject: "", message: "", projectId: "" });
    setFiles([]);
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4" style={muted} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            placeholder="Search help"
            aria-label="Search help"
            className="w-full rounded-xl border bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none"
          />
        </div>
        <ul className="mt-3 divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm" style={muted}>
              Nothing matches. Try other words, or contact us below.
            </li>
          )}
          {results.map((a) => (
            <li key={a.slug}>
              <button
                onClick={() => setOpen(open === a.slug ? null : a.slug)}
                aria-expanded={open === a.slug}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-black/[.02]"
              >
                {a.title}
                <span className="text-xs" style={muted}>
                  {a.section}
                </span>
              </button>
              {open === a.slug && <p className="px-4 pb-4 text-sm leading-relaxed" style={muted}>{a.body}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section id="contact">
        <h2 className="mb-1 text-sm font-medium">Contact support</h2>
        <p className="mb-3 text-xs" style={muted}>
          Your workspace, plan and browser are included automatically.
        </p>
        {state.kind === "sent" ? (
          <p className="rounded-xl border px-4 py-6 text-sm" role="status">
            Thanks. Your ticket is <span className="font-mono">{state.text}</span>; we&apos;ll reply by email.
          </p>
        ) : (
          <div className="space-y-2.5 rounded-xl border p-4" style={{ background: "var(--panel)" }}>
            <input
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="Subject"
              aria-label="Subject"
              maxLength={140}
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            />
            <select
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              aria-label="Related project"
              className="w-full rounded-lg border bg-transparent px-2.5 py-2 text-sm"
            >
              <option value="">No specific project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <textarea
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              rows={5}
              placeholder="What happened, and what did you expect?"
              aria-label="Message"
              className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                multiple
                hidden
                onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 5))}
              />
              <button onClick={() => fileRef.current?.click()} className="rounded-lg border px-2.5 py-1">
                Add screenshots
              </button>
              <span style={muted}>Up to 5 JPG/PNG, 5 MB total.</span>
              {files.map((f, i) => (
                <span key={i} className="rounded-md border px-1.5 py-0.5">
                  {f.name}{" "}
                  <button onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            {state.kind === "error" && (
              <p className="text-xs text-red-500" role="alert">
                {state.text}
              </p>
            )}
            <div className="flex justify-end">
              <button
                onClick={send}
                disabled={state.kind === "sending" || !form.subject.trim() || !form.message.trim()}
                className="rounded-lg px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                style={{ background: "var(--accent)" }}
              >
                {state.kind === "sending" ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
