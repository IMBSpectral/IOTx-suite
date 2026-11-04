"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck, Check, Gift, PartyPopper } from "lucide-react";

type Reward = { id: string; title: string; detail: string; credits: number; href?: string; earned: boolean; claimed: boolean };
type Data = {
  rewards: Reward[];
  daily: { id: string; credits: number; claimed: boolean };
  welcomeBack: { id: string; credits: number; claimed: boolean } | null;
  totalEarned: number;
  workspaces: { id: string; name: string }[];
  currentWorkspace: string;
};

const muted = { color: "var(--muted)" };

/** "Explore Forge. Earn bonuses.": rewards for trying things, claimed into a workspace you choose. */
export default function RewardsPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [version, setVersion] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/rewards")
      .then((r) => r.json())
      .then((d) => live && setData(d))
      .catch(() => live && setError("Couldn't load rewards."));
    return () => {
      live = false;
    };
  }, [version]);

  async function claim(rewardId: string) {
    if (!data) return;
    setBusy(rewardId);
    setError(null);
    setNote(null);
    const workspaceId = target ?? data.currentWorkspace;
    const res = await fetch("/api/rewards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rewardId, workspaceId }) });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) setError(d.error ?? "Couldn't claim that.");
    else setNote(`+${d.credits} credits added to ${data.workspaces.find((w) => w.id === workspaceId)?.name ?? "your workspace"}.`);
    setVersion((v) => v + 1);
  }

  if (!data) return <p className="text-sm" style={muted}>{error ?? "Loading…"}</p>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" style={muted}>
          You&apos;ve earned {data.totalEarned} bonus credits so far.
        </p>
        {data.workspaces.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs">
            Claim into
            <select value={target ?? data.currentWorkspace} onChange={(e) => setTarget(e.target.value)} className="rounded-md border bg-transparent px-1.5 py-0.5" aria-label="Workspace to claim into">
              {data.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {(note || error) && (
        <p role={error ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-xs ${error ? "text-red-600 dark:text-red-400" : ""}`}>
          {error ?? note}
        </p>
      )}

      {data.welcomeBack && !data.welcomeBack.claimed && (
        <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ background: "var(--accent-soft)" }}>
          <PartyPopper className="h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Welcome back!</p>
            <p className="text-xs" style={muted}>It&apos;s been a while. Here&apos;s a gift to get building again.</p>
          </div>
          <ClaimButton id={data.welcomeBack.id} credits={data.welcomeBack.credits} claimed={false} busy={busy} onClaim={claim} />
        </div>
      )}

      <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ background: "var(--panel)" }}>
        <CalendarCheck className="h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Daily bonus</p>
          <p className="text-xs" style={muted}>Come back each day for a free credit.</p>
        </div>
        <ClaimButton id={data.daily.id} credits={data.daily.credits} claimed={data.daily.claimed} busy={busy} onClaim={claim} />
      </div>

      <ul className="divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
        {data.rewards.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-3">
            <Gift className={`h-4 w-4 shrink-0 ${r.earned ? "" : "opacity-40"}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{r.title}</p>
              <p className="text-xs" style={muted}>{r.detail}</p>
            </div>
            {r.earned ? (
              <ClaimButton id={r.id} credits={r.credits} claimed={r.claimed} busy={busy} onClaim={claim} />
            ) : r.href ? (
              <Link href={r.href} className="rounded-lg border px-3 py-1 text-xs">
                Start · +{r.credits}
              </Link>
            ) : (
              <span className="text-xs" style={muted}>+{r.credits}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClaimButton({ id, credits, claimed, busy, onClaim }: { id: string; credits: number; claimed: boolean; busy: string | null; onClaim: (id: string) => void }) {
  if (claimed) {
    return (
      <span className="flex items-center gap-1 text-xs" style={muted}>
        <Check className="h-3.5 w-3.5" /> Claimed
      </span>
    );
  }
  return (
    <button onClick={() => onClaim(id)} disabled={!!busy} className="btn-primary rounded-lg px-3 py-1 text-xs disabled:opacity-50">
      {busy === id ? "Claiming…" : `Claim +${credits}`}
    </button>
  );
}
