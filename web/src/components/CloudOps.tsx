"use client";

import { useCallback, useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import McpServerCard from "./McpServerCard";
import EmailDomainCard from "./EmailDomainCard";
import { Activity, AlertTriangle, Mail, Pause, Play, RotateCw, ShieldCheck, Sparkles } from "lucide-react";

type Health = {
  status: "healthy" | "high_load" | "needs_attention" | "paused";
  paused: { reason: string; at: string; text: string } | null;
  reasons: string[];
  requestsLastHour: number;
  errorsLastHour: number;
  perMinute: number;
  dbBytes: number;
  lastActiveAt: string | null;
  ai: { enabled: boolean; callsToday: number; creditsToday: number };
  email: { enabled: boolean; sentToday: number; connected: boolean; mailboxId: string | null; senders: { id: string; email: string; displayName: string | null; status: string }[] };
};
type Finding = { id: string; severity: "error" | "warning" | "info"; table?: string; title: string; detail: string; fix: string };
type Email = { id: string; to: string; subject: string; text: string; html: string | null; status: string; error?: string; at: string; by: string | null; from?: string; delivery?: string };
type Rate = { sentLastHour: number; limit: number; resetsAt: string | null };

const STATUS: Record<Health["status"], { label: string; color: string }> = {
  healthy: { label: "Healthy", color: "#059669" },
  high_load: { label: "Your app is under high load", color: "#d97706" },
  needs_attention: { label: "Cloud instance needs attention", color: "#dc2626" },
  paused: { label: "Paused", color: "var(--muted)" },
};
const SEVERITY: Record<Finding["severity"], string> = { error: "#dc2626", warning: "#d97706", info: "var(--muted)" };

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Health, pause/wake, AI and email switches, the linter and the email outbox for a Cloud project. */
export default function CloudOps({
  projectId,
  onSend,
  onChanged,
}: {
  projectId: string;
  onSend?: (text: string) => void;
  /** Tell the Cloud panel to reload (a new migration is waiting). */
  onChanged?: () => void;
}) {
  const brand = useBrand();
  const base = `/api/projects/${projectId}/cloud`;
  const muted = { color: "var(--muted)" };
  const [health, setHealth] = useState<Health | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [rate, setRate] = useState<Rate | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(`${base}?view=health`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${base}?view=outbox`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([h, o]) => {
      if (!live) return;
      if (h) setHealth(h);
      if (o) {
        setEmails(o.emails);
        setRate(o.rate ?? null);
      }
    });
    return () => {
      live = false;
    };
  }, [base, version]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) setError(d.error ?? "Something went wrong");
    reload();
  }

  async function lint() {
    setBusy("lint");
    const d = await (await fetch(`${base}?view=lint`)).json().catch(() => ({ findings: [] }));
    setFindings(d.findings ?? []);
    setBusy(null);
  }

  if (!health) return null;
  const s = STATUS[health.status];

  return (
    <div className="space-y-6">
      <section aria-label="Backend health" className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 font-medium">
              <Activity className="h-4 w-4" />
              <span style={{ color: s.color }}>{s.label}</span>
            </p>
            {health.paused && <p className="mt-0.5 text-xs" style={muted}>{health.paused.text} The app&apos;s data and sign-in answer with an error until you wake it.</p>}
            {health.reasons.map((r) => (
              <p key={r} className="mt-0.5 text-xs text-red-600">
                {r}
              </p>
            ))}
          </div>
          <div className="flex shrink-0 gap-1.5 text-xs">
            {health.paused ? (
              <button
                onClick={() => act("wake")}
                disabled={!!busy}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                <Play className="h-3 w-3" /> Wake up
              </button>
            ) : (
              <button onClick={() => act("pause")} disabled={!!busy} className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5">
                <Pause className="h-3 w-3" /> Pause
              </button>
            )}
            <button onClick={() => act("restart")} disabled={!!busy} className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5" title="Restart the database connection">
              <RotateCw className="h-3 w-3" /> Restart
            </button>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          {[
            ["Requests (1h)", String(health.requestsLastHour)],
            ["Errors (1h)", String(health.errorsLastHour)],
            ["Database", bytes(health.dbBytes)],
            ["Last active", health.lastActiveAt ? new Date(health.lastActiveAt).toLocaleString() : "—"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border px-2.5 py-2">
              <dt style={muted}>{k}</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {error && (
          <p className="mt-2 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </section>

      <section aria-label="AI and email" className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 font-medium">
              <Sparkles className="h-4 w-4" /> AI
            </p>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={health.ai.enabled} onChange={(e) => act("features", { ai: e.target.checked })} /> On
            </label>
          </div>
          <p className="mt-1 text-xs" style={muted}>
            The app can chat with and generate text from AI models through {brand.shortName}, billed to your credits.
          </p>
          <p className="mt-2 text-xs tabular-nums">
            Today: {health.ai.callsToday} calls · {health.ai.creditsToday} credits
          </p>
          <button
            onClick={() =>
              onSend?.(
                `Add AI functions to this app using ${brand.shortName} Cloud's AI (cloud.ai.chat and cloud.ai.generate from the Cloud client): pick the most useful ones for what the app does, such as a chat assistant, summaries, or smart suggestions, and wire them into the UI with loading and error states.`,
              )
            }
            className="mt-2 text-xs underline"
          >
            Add AI functions to your app: chat assistant, summaries and more
          </button>
        </div>
        <div className="rounded-xl border p-4" style={{ background: "var(--panel)" }}>
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 font-medium">
              <Mail className="h-4 w-4" /> Email
            </p>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={health.email.enabled} onChange={(e) => act("features", { email: e.target.checked })} /> On
            </label>
          </div>
          <label className="mt-2 block text-xs font-medium" htmlFor="app-mail-sender">Send from</label>
          <select
            id="app-mail-sender"
            className="mt-1 w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm"
            value={health.email.mailboxId ?? ""}
            disabled={!!busy}
            onChange={(e) => act("features", { mailboxId: e.target.value || null })}
          >
            <option value="">{health.email.connected ? "Resend account (RESEND_API_KEY)" : "Don't send: keep in the outbox"}</option>
            {health.email.senders.map((b) => (
              <option key={b.id} value={b.id}>
                {b.displayName ? `${b.displayName} <${b.email}>` : b.email}{b.status === "error" ? " (sign-in failing)" : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs" style={muted}>
            {health.email.mailboxId
              ? "Emails go out from your company's own mailbox and appear in its Sent folder."
              : health.email.senders.length
                ? "Pick a company mailbox to send for real, from your own address."
                : health.email.connected
                  ? "Sending through your Resend account."
                  : "Emails are kept in the outbox below. Connect a shared mailbox in Settings → Mailboxes to send them from your company's address."}
          </p>
          <p className="mt-2 text-xs tabular-nums">Today: {health.email.sentToday} emails</p>
        </div>
        <p className="text-xs sm:col-span-2" style={muted}>
          Apps made before AI and email arrived need the newer client file.{" "}
          <button onClick={() => act("refreshClient")} disabled={!!busy} className="underline">
            Update the app&apos;s Cloud client
          </button>
        </p>
      </section>

      <EmailDomainCard projectId={projectId} connected={health.email.connected} />

      <McpServerCard projectId={projectId} />

      <section aria-label="Backend checks">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 font-medium">
            <ShieldCheck className="h-4 w-4" /> Backend checks
          </h3>
          <button onClick={lint} disabled={!!busy} className="rounded-lg border px-2.5 py-1 text-xs">
            {busy === "lint" ? "Checking…" : findings ? "Check again" : "Run checks"}
          </button>
        </div>
        {findings?.some((f) => f.id.startsWith("index:") || f.id.startsWith("user-id-index:")) && (
          <div className="mt-2 flex items-center gap-2 rounded-xl border p-3 text-xs" style={{ background: "var(--panel)" }}>
            <span className="flex-1">Some lookups scan whole tables. Add the missing indexes in one migration you approve.</span>
            <button
              onClick={async () => {
                await act("optimize");
                onChanged?.();
                void lint();
              }}
              disabled={!!busy}
              className="rounded-lg px-2.5 py-1 font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              Optimize database
            </button>
          </div>
        )}
        {findings && findings.length === 0 && (
          <p className="mt-2 text-xs text-emerald-700">No problems found.</p>
        )}
        {findings && findings.length > 0 && (
          <ul className="mt-2 space-y-2">
            {findings.map((f) => (
              <li key={f.id} className="rounded-xl border p-3 text-xs" style={{ background: "var(--panel)" }}>
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: SEVERITY[f.severity] }} />
                  {f.title}
                </p>
                <p className="mt-0.5" style={muted}>
                  {f.detail}
                </p>
                {onSend && (
                  <button onClick={() => onSend(`Fix this backend problem: ${f.title}. ${f.fix}`)} className="mt-2 rounded-md border px-2 py-0.5">
                    Fix with the agent
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Email outbox">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 font-medium">
            <Mail className="h-4 w-4" /> Email outbox
          </h3>
          {emails.some((m) => m.status === "sent") && (
            <button onClick={() => act("refreshDeliveries")} disabled={!!busy} className="rounded-lg border px-2.5 py-1 text-xs">
              {busy === "refreshDeliveries" ? "Checking…" : "Check delivery"}
            </button>
          )}
        </div>
        {rate && (
          <p className="mt-1 text-xs tabular-nums" aria-label="Sending limit" style={rate.resetsAt ? { color: "#dc2626" } : muted}>
            {rate.sentLastHour} of {rate.limit} emails this hour
            {rate.resetsAt ? ` · limit reached, sending resumes at ${new Date(rate.resetsAt).toLocaleTimeString()}` : ""}
          </p>
        )}
        {emails.length === 0 ? (
          <p className="mt-1 text-xs" style={muted}>
            Emails the app sends show up here.
          </p>
        ) : (
          <ul className="mt-2 divide-y rounded-xl border text-xs" style={{ background: "var(--panel)" }}>
            {emails.slice(0, 20).map((m) => (
              <li key={m.id} className="p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate font-medium">{m.subject}</p>
                  <span
                    className={m.status === "failed" || /bounced|complained/.test(m.delivery ?? "") ? "text-red-600" : m.status === "sent" ? "text-emerald-700" : ""}
                    style={m.status === "captured" ? muted : undefined}
                  >
                    {m.status === "captured" ? "In outbox" : m.delivery ? m.delivery.replace(/_/g, " ") : m.status}
                  </span>
                </div>
                <p className="mt-0.5" style={muted}>
                  To {m.to} · {new Date(m.at).toLocaleString()}
                  {m.from ? ` · as ${m.from}` : ""}
                  {m.by ? ` · by ${m.by}` : ""}
                </p>
                {m.text && <p className="mt-1 line-clamp-2 whitespace-pre-wrap">{m.text}</p>}
                {m.error && <p className="mt-1 text-red-600">{m.error}</p>}
                <button onClick={() => setPreview(preview === m.id ? null : m.id)} className="mt-1 underline">
                  {preview === m.id ? "Hide preview" : "Preview"}
                </button>
                {preview === m.id &&
                  (m.html ? (
                    // Sandboxed with no permissions: the email's HTML can't run scripts or reach the page.
                    <iframe title={`Preview: ${m.subject}`} sandbox="" srcDoc={m.html} className="mt-2 h-72 w-full rounded-lg border bg-white" />
                  ) : (
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border p-2 font-sans">{m.text}</pre>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
