"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import Link from "next/link";
import { Clock, Pause, Play, Plus, Trash2, Zap } from "lucide-react";

type Automation = {
  id: string;
  name: string;
  prompt: string;
  mode: string;
  projectId: string;
  projectName: string;
  schedule: string;
  scheduleText: string;
  timezone: string;
  status: "active" | "paused" | "done";
  pausedReason: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  runs: number;
  webhookUrl: string | null;
};
type Kind = "once" | "hourly" | "daily" | "weekdays" | "days" | "monthly" | "cron";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function statusLabel(a: Automation) {
  if (a.status === "done") return "Done";
  if (a.status === "active") return "Active";
  if (a.pausedReason === "failing") return "Paused · failing";
  if (a.pausedReason === "credits") return "Paused · out of credits";
  return "Paused";
}

/** Build the schedule string the server stores from the form's friendly fields. */
function toSchedule(f: { kind: Kind; time: string; days: number[]; dom: string; cron: string; once: string }, tz: string) {
  const [h, m] = (f.time || "09:00").split(":").map(Number);
  switch (f.kind) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "days":
      return `${m} ${h} * * ${f.days.length ? f.days.join(",") : "1"}`;
    case "monthly":
      return `${m} ${h} ${f.dom || "1"} * *`;
    case "cron":
      return f.cron.trim();
    case "once": {
      // datetime-local is wall-clock time in the chosen zone; find the matching instant.
      const local = new Date(`${f.once}:00Z`);
      const asTz = new Date(local.toLocaleString("en-US", { timeZone: tz }) + " UTC");
      const offset = asTz.getTime() - local.getTime();
      return `once:${new Date(local.getTime() - offset).toISOString()}`;
    }
  }
}

export default function AutomationsPanel({ projects }: { projects: { id: string; name: string }[] }) {
  const [items, setItems] = useState<Automation[]>([]);
  const brand = useBrand();
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const [form, setForm] = useState({
    projectId: projects[0]?.id ?? "",
    name: "",
    prompt: "",
    mode: "build",
    kind: "daily" as Kind,
    time: "09:00",
    days: [1, 3, 5],
    dom: "1",
    cron: "0 9 * * 1-5",
    once: "",
    timezone: browserTz,
  });
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    let live = true;
    // Settle finished runs first so results show without waiting for the next minute.
    fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "tick" }) })
      .catch(() => undefined)
      .then(() => fetch("/api/automations"))
      .then((r) => (r && r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setItems(d.automations);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [version]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    setVersion((v) => v + 1);
    if (!res.ok) setError(d.error ?? "Something went wrong");
    return res.ok;
  }

  async function create() {
    const schedule = toSchedule(form, form.timezone);
    if (
      await act({
        action: "create",
        projectId: form.projectId,
        name: form.name,
        prompt: form.prompt,
        mode: form.mode,
        schedule,
        timezone: form.timezone,
      })
    ) {
      setCreating(false);
      setForm({ ...form, name: "", prompt: "" });
    }
  }

  const input = "w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm" style={muted}>
          Run a prompt on a schedule: a daily check, a weekly report, a reminder to the agent. Each run is a normal turn in
          the project&apos;s chat.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            disabled={!projects.length}
            className="flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            <Plus className="h-4 w-4" /> New automation
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      {creating && (
        <section className="space-y-2.5 rounded-xl border p-4" style={{ background: "var(--panel)" }} aria-label="New automation">
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name, e.g. Morning health check" aria-label="Name" className={input} />
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} aria-label="Project" className={input}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            rows={3}
            placeholder={`What should ${brand.shortName} do each time? e.g. Check the app for broken links and fix any you find.`}
            aria-label="Prompt"
            className={`${input} resize-y`}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })} aria-label="Repeat" className="rounded-md border bg-transparent px-1.5 py-1">
              <option value="once">Once</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="days">Specific days</option>
              <option value="monthly">Monthly</option>
              <option value="cron">Custom (cron)</option>
            </select>
            {form.kind === "once" && (
              <input type="datetime-local" value={form.once} onChange={(e) => setForm({ ...form, once: e.target.value })} aria-label="When" className="rounded-md border bg-transparent px-1.5 py-1" />
            )}
            {["daily", "weekdays", "days", "monthly"].includes(form.kind) && (
              <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} aria-label="Time" className="rounded-md border bg-transparent px-1.5 py-1" />
            )}
            {form.kind === "monthly" && (
              <label className="flex items-center gap-1">
                on day
                <input value={form.dom} onChange={(e) => setForm({ ...form, dom: e.target.value.replace(/\D/g, "") })} aria-label="Day of month" className="w-12 rounded-md border bg-transparent px-1.5 py-1" />
              </label>
            )}
            {form.kind === "days" &&
              DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-0.5">
                  <input
                    type="checkbox"
                    checked={form.days.includes(i)}
                    onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, i].sort() : form.days.filter((x) => x !== i) })}
                  />
                  {d}
                </label>
              ))}
            {form.kind === "cron" && (
              <input value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} aria-label="Cron expression" placeholder="minute hour day month weekday" className="w-44 rounded-md border bg-transparent px-1.5 py-1 font-mono" />
            )}
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} aria-label="Time zone" className="rounded-md border bg-transparent px-1.5 py-1">
              {[...new Set([browserTz, "UTC", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Singapore", "Australia/Sydney"])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} aria-label="Mode" className="rounded-md border bg-transparent px-1.5 py-1">
              <option value="build">Build (can change the app)</option>
              <option value="ask">Ask (report only)</option>
            </select>
          </div>
          <div className="flex justify-end gap-1.5 text-sm">
            <button onClick={() => setCreating(false)} className="rounded-lg px-3 py-1.5" style={muted}>
              Cancel
            </button>
            <button onClick={create} disabled={!form.name.trim() || !form.prompt.trim()} className="rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-40" style={{ background: "var(--accent)" }}>
              Create
            </button>
          </div>
        </section>
      )}

      <ul className="space-y-2">
        {items.length === 0 && !creating && (
          <li className="rounded-xl border border-dashed px-4 py-10 text-center text-sm" style={muted}>
            No automations yet.
          </li>
        )}
        {items.map((a) => (
          <li key={a.id} className="rounded-xl border p-3" style={{ background: "var(--panel)" }}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Zap className="h-3.5 w-3.5" /> {a.name}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] ${a.status === "active" ? "bg-emerald-500/10 text-emerald-700" : a.pausedReason && a.pausedReason !== "manual" ? "bg-red-500/10 text-red-700" : "bg-black/[.05]"}`}
                  >
                    {statusLabel(a)}
                  </span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]" style={muted}>
                  <Clock className="h-3 w-3" /> {a.scheduleText} ({a.timezone}) ·{" "}
                  <Link href={`/projects/${a.projectId}`} className="hover:underline">
                    {a.projectName}
                  </Link>
                  {a.nextRunAt && ` · next ${new Date(a.nextRunAt).toLocaleString()}`}
                  {` · ${a.runs} ${a.runs === 1 ? "run" : "runs"}`}
                </span>
              </span>
              <span className="flex gap-1.5 text-xs">
                <button onClick={() => act({ action: "run", id: a.id })} className="flex items-center gap-1 rounded-md border px-2 py-1">
                  <Play className="h-3 w-3" /> Run now
                </button>
                {a.status === "active" ? (
                  <button onClick={() => act({ action: "pause", id: a.id })} className="flex items-center gap-1 rounded-md border px-2 py-1">
                    <Pause className="h-3 w-3" /> Pause
                  </button>
                ) : (
                  a.status === "paused" && (
                    <button onClick={() => act({ action: "resume", id: a.id })} className="rounded-md border px-2 py-1">
                      Resume
                    </button>
                  )
                )}
                <button
                  onClick={() => act({ action: "webhook", id: a.id, on: !a.webhookUrl })}
                  aria-pressed={!!a.webhookUrl}
                  title="Run this automation when a URL receives a POST"
                  className={`rounded-md border px-2 py-1 ${a.webhookUrl ? "border-[var(--accent)]" : ""}`}
                >
                  Webhook
                </button>
                <button
                  onClick={() => confirm(`Delete "${a.name}"?`) && act({ action: "delete", id: a.id })}
                  aria-label={`Delete ${a.name}`}
                  className="rounded-md px-1.5 py-1 text-red-500 hover:bg-red-500/[.08]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-xs" style={muted}>
              {a.prompt}
            </p>
            {a.webhookUrl && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                <span style={muted}>POST to</span>
                <input
                  readOnly
                  value={a.webhookUrl}
                  aria-label={`Webhook URL for ${a.name}`}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 font-mono"
                />
                <button onClick={() => void navigator.clipboard.writeText(a.webhookUrl!)} className="rounded border px-1.5 py-0.5">
                  Copy
                </button>
                <span style={muted}>Body (≤10 KB) is passed to the agent. Turning the webhook off revokes the URL.</span>
              </div>
            )}
            {a.lastRunAt && (
              <p className="mt-1 text-[11px]">
                <span style={muted}>Last run {new Date(a.lastRunAt).toLocaleString()}: </span>
                {a.lastResult ?? "running…"}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
