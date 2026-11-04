"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLES, roleNames, type Starter } from "@/lib/onboarding";

/** Onboarding: your role, the tasks that fill your week, then a preview of your workspace. */
export default function Welcome() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [role, setRole] = useState("");
  const [tasks, setTasks] = useState<string[]>([]);
  const [starters, setStarters] = useState<Starter[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  const chip = (on: boolean) => `rounded-xl border px-3 py-2 text-left text-sm ${on ? "border-[var(--accent)] font-medium" : ""}`;

  async function preview() {
    setError("");
    const r = await fetch("/api/account/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, tasks }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "That didn't work");
    setStarters(d.starters);
    setStep(3);
  }

  async function build(s: Starter) {
    setBusy(s.name);
    const r = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: s.name, force: true }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setBusy(null);
      return setError(d.error ?? "Couldn't create the project");
    }
    sessionStorage.setItem(`seed:${d.project.id}`, s.prompt);
    router.push(`/projects/${d.project.id}`);
  }

  async function skip() {
    await fetch("/api/account/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skip: true }) });
    router.push("/dashboard");
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-12">
      <p className="text-xs" style={muted}>
        Step {step} of 3
      </p>
      {step === 1 && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">What do you do?</h1>
          <p className="text-sm" style={muted}>
            We&apos;ll suggest apps for the work you actually do.
          </p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Your role">
            {roleNames.map((r) => (
              <button key={r} role="radio" aria-checked={role === r} onClick={() => { setRole(r); setTasks([]); }} className={chip(role === r)}>
                {r}
              </button>
            ))}
          </div>
          <div className="flex justify-between">
            <button onClick={() => void skip()} className="text-sm hover:underline" style={muted}>
              Skip
            </button>
            <button disabled={!role} onClick={() => setStep(2)} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--accent)" }}>
              Next
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">What fills your week?</h1>
          <p className="text-sm" style={muted}>
            Pick up to five.
          </p>
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Your tasks">
            {(ROLES[role] ?? []).map((s) => {
              const on = tasks.includes(s.task);
              return (
                <button
                  key={s.task}
                  aria-pressed={on}
                  onClick={() => setTasks(on ? tasks.filter((t) => t !== s.task) : tasks.length < 5 ? [...tasks, s.task] : tasks)}
                  className={chip(on)}
                >
                  {s.task}
                </button>
              );
            })}
          </div>
          {error && (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="text-sm hover:underline" style={muted}>
              Back
            </button>
            <button disabled={!tasks.length} onClick={() => void preview()} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: "var(--accent)" }}>
              See my workspace
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Your workspace, ready to build</h1>
          <p className="text-sm" style={muted}>
            One app for each part of your week. Start any of them now; you can change everything by chatting.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {starters.map((s) => (
              <li key={s.name} className="flex flex-col rounded-xl border p-4" style={{ background: "var(--panel)" }}>
                <p className="text-[11px] uppercase tracking-wider" style={muted}>
                  {s.task}
                </p>
                <p className="mt-1 text-sm font-medium">{s.name}</p>
                <p className="mt-1 flex-1 text-xs" style={muted}>
                  {s.prompt}
                </p>
                <button onClick={() => void build(s)} disabled={busy !== null} className="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" style={{ background: "var(--accent)" }}>
                  {busy === s.name ? "Creating…" : "Build this"}
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="text-sm hover:underline" style={muted}>
              Back
            </button>
            <button onClick={() => router.push("/dashboard")} className="rounded-lg border px-4 py-2 text-sm">
              Go to dashboard
            </button>
          </div>
        </>
      )}
    </div>
  );
}
