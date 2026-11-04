"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { useRouter } from "next/navigation";

type Billing = {
  isAdmin: boolean;
  plan: "FREE" | "PRO" | "BUSINESS";
  balance: number;
  monthlyCredits: number;
  autoTopup: { on: boolean; amount: number };
  rollover: { credits: number; expiresAt: string | null; nudge: string | null };
  nextRefill: string;
  meteredTermsAccepted: boolean;
  connectorRequests: { kind: string; requests: number }[];
  period: { start: string; end: string };
  salesRequestedAt: string | null;
  grants: { chats: { daily: number; usedToday: number }; voice: { dailyMinutes: number; usedMinutes: number }; monthlyCredits: number; securityFixes: boolean };
  workspaceLimit: number | null;
  spentThisMonth: number;
  topups: number[];
  usage: {
    byCategory: Record<string, number>;
    byProject: { id: string | null; name: string; credits: number }[];
    byUser: { id: string | null; name: string; credits: number }[];
    daily: { day: string; credits: number }[];
  };
  limits: { id: string; scope: "user" | "project"; targetId: string; name: string; monthly: number; spent: number }[];
  members: { id: string; name: string | null }[];
  projects: { id: string; name: string }[];
};

const PLANS = [
  { id: "FREE", name: "Free", credits: 30, price: "$0", blurb: "For trying things out." },
  { id: "PRO", name: "Pro", credits: 500, price: "$25", blurb: "For regular building." },
  { id: "BUSINESS", name: "Business", credits: 2000, price: "$100", blurb: "For teams, with SSO." },
] as const;

const CATEGORIES = [
  ["build", "Build"],
  ["chat", "Chat"],
  ["media", "Media"],
  ["cloud", "Cloud"],
] as const;

const card = "rounded-xl border p-5";
const muted = { color: "var(--muted)" };

/** Daily credits, last 30 days: one series, one hue, hover for the value. */
function DailyBars({ data }: { data: Billing["usage"]["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.credits));
  const h = 96;
  const w = 100 / data.length;
  const total = data.reduce((s, d) => s + d.credits, 0);
  return (
    <figure className="relative">
      <figcaption className="mb-2 text-xs" style={muted}>
        Credits per day, last 30 days · {total} total
      </figcaption>
      <svg
        viewBox={`0 0 100 ${h}`}
        preserveAspectRatio="none"
        className="block h-24 w-full"
        role="img"
        aria-label={`Daily credit use over 30 days, ${total} credits in total`}
        onMouseLeave={() => setHover(null)}
      >
        <line x1="0" x2="100" y1={h - 0.5} y2={h - 0.5} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {data.map((d, i) => {
          const bh = d.credits ? Math.max(2, (d.credits / max) * (h - 6)) : 0;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              {/* Hit target spans the whole column, bigger than the bar. */}
              <rect x={i * w} y={0} width={w} height={h} fill="transparent" />
              {bh > 0 && (
                <rect
                  x={i * w + w * 0.15}
                  y={h - bh}
                  width={w * 0.7}
                  height={bh}
                  rx={0.8}
                  fill="var(--accent)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-5 -translate-x-1/2 rounded-md border px-2 py-1 text-[11px] shadow-sm"
          style={{ left: `${(hover + 0.5) * w}%`, background: "var(--panel)" }}
        >
          <span style={muted}>{new Date(data[hover].day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}</span>{" "}
          <span className="font-medium tabular-nums">{data[hover].credits}</span>
        </div>
      )}
      <div className="mt-1 flex justify-between text-[10px]" style={muted}>
        <span>{new Date(data[0].day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}</span>
        <span>Today</span>
      </div>
    </figure>
  );
}

function Rows({ rows, empty }: { rows: { name: string; credits: number; key: string }[]; empty: string }) {
  if (!rows.length) return <p className="text-xs" style={muted}>{empty}</p>;
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b last:border-0">
            <td className="truncate py-1.5 pr-2">{r.name}</td>
            <td className="py-1.5 text-right tabular-nums">{r.credits}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function BillingPanel() {
  const router = useRouter();
  const brand = useBrand();
  const [data, setData] = useState<Billing | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limitForm, setLimitForm] = useState({ scope: "user", targetId: "", monthly: "" });
  const [wsLimit, setWsLimit] = useState("");
  const [autoAmount, setAutoAmount] = useState("");
  // An action waiting on the usage-terms dialog.
  const [termsFor, setTermsFor] = useState<Record<string, unknown> | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [salesOpen, setSalesOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/workspace/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Billing | null) => {
        if (!live || !d) return;
        setData(d);
        setWsLimit(d.workspaceLimit?.toString() ?? "");
        setAutoAmount(d.autoTopup.amount ? String(d.autoTopup.amount) : "100");
      });
    return () => {
      live = false;
    };
  }, [version]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/workspace/billing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.status === 409 && d.needsTerms) {
      setAgreed(false);
      setTermsFor(body);
      return false;
    }
    if (!res.ok) {
      setError(d.error ?? "Something went wrong");
      return false;
    }
    setVersion((v) => v + 1);
    router.refresh();
    return true;
  }

  if (!data) return <p className="text-sm" style={muted}>Loading billing…</p>;
  const pct = data.monthlyCredits > 0 ? Math.min(100, (data.spentThisMonth / data.monthlyCredits) * 100) : 0;
  const admin = data.isAdmin;

  return (
    <div className="space-y-8">
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/[.06] px-3 py-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}

      {termsFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setTermsFor(null)}>
          <div
            role="dialog"
            aria-label="Usage-based billing terms"
            className="w-full max-w-md rounded-2xl border p-5 shadow-2xl"
            style={{ background: "var(--panel)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold">Usage-based billing</h2>
            <ul className="mt-3 list-disc space-y-1.5 pl-4 text-xs" style={muted}>
              <li>When your balance drops below 10 credits, {brand.shortName} adds the amount you chose and charges your payment method.</li>
              <li>This can happen more than once a month, as often as your projects use credits.</li>
              <li>Spending limits still apply: builds stop when a workspace, member or project limit is reached.</li>
              <li>Top-up credits don&apos;t expire. You can turn this off at any time.</li>
            </ul>
            <label className="mt-4 flex items-start gap-2 text-xs">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
              I agree to usage-based billing for this workspace.
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setTermsFor(null)} className="rounded-lg border px-3 py-1.5 text-xs">
                Cancel
              </button>
              <button
                disabled={!agreed || busy}
                onClick={async () => {
                  const body = termsFor;
                  setTermsFor(null);
                  await act({ ...body, acceptTerms: true });
                }}
                className="btn-primary rounded-lg px-3 py-1.5 text-xs disabled:opacity-50"
              >
                Turn on
              </button>
            </div>
          </div>
        </div>
      )}

      <section id="credits">
        <h2 className="mb-3 text-sm font-medium">Credits</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <div className="flex items-baseline justify-between">
            <span className="text-3xl font-semibold tabular-nums">{data.balance}</span>
            <span className="text-xs" style={muted}>
              {data.spentThisMonth} used this month
              {data.workspaceLimit != null && ` · limit ${data.workspaceLimit}`}
            </span>
          </div>
          <div
            className="mt-4 h-1.5 overflow-hidden rounded-full"
            style={{ background: "var(--border)" }}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Monthly credit usage"
          >
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--accent)" }} />
          </div>
          <p className="mt-2 text-xs" style={muted}>
            On the {data.plan.charAt(0) + data.plan.slice(1).toLowerCase()} plan, {data.monthlyCredits} credits a month.
            {" "}Refills on {new Date(data.nextRefill).toLocaleDateString(undefined, { day: "numeric", month: "long" })}.
            {data.plan === "FREE" ? " Unused monthly credits don't carry over." : " Unused monthly credits roll over for one more month."}
          </p>
          {data.rollover.credits > 0 && data.rollover.expiresAt && (
            <p className={`mt-1 text-xs ${data.rollover.nudge ? "font-medium text-amber-600 dark:text-amber-400" : ""}`} style={data.rollover.nudge ? undefined : muted}>
              {data.rollover.nudge
                ? `${data.rollover.nudge[0].toUpperCase()}${data.rollover.nudge.slice(1)}. They're used before your other credits.`
                : `Includes ${data.rollover.credits} rollover credits, used first, expiring ${new Date(data.rollover.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}.`}
            </p>
          )}
          {admin && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">Top up</span>
              {data.topups.map((n) => (
                <button
                  key={n}
                  disabled={busy}
                  onClick={() => act({ action: "topup", amount: n })}
                  className="rounded-lg border px-2.5 py-1 text-xs hover:bg-black/[.04] disabled:opacity-50"
                >
                  +{n}
                </button>
              ))}
              <span className="text-[11px]" style={muted}>
                Test mode: no payment is taken.
              </span>
            </div>
          )}
          {admin && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={data.autoTopup.on}
                  onChange={(e) => act({ action: "autoTopup", on: e.target.checked, amount: Number(autoAmount) })}
                />
                Auto top-up when the balance drops below 10, adding
              </label>
              <input
                value={autoAmount}
                onChange={(e) => setAutoAmount(e.target.value.replace(/\D/g, ""))}
                onBlur={() => data.autoTopup.on && act({ action: "autoTopup", on: true, amount: Number(autoAmount) })}
                aria-label="Auto top-up amount"
                inputMode="numeric"
                className="w-16 rounded-md border bg-transparent px-1.5 py-0.5"
              />
              credits
            </div>
          )}
        </div>
      </section>

      <section id="plan">
        <h2 className="mb-3 text-sm font-medium">Plan and contract</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <p className="text-sm">
            {data.plan.charAt(0) + data.plan.slice(1).toLowerCase()} plan · current period{" "}
            {new Date(data.period.start).toLocaleDateString(undefined, { day: "numeric", month: "short" })} –{" "}
            {new Date(data.period.end).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          </p>
          <p className="mt-1 text-xs" style={muted}>
            Need more seats, SSO, invoicing or a custom contract? Tell us about your team.
          </p>
          {data.salesRequestedAt ? (
            <p className="mt-2 text-xs">Request sent {new Date(data.salesRequestedAt).toLocaleDateString()}. We&apos;ll be in touch by email.</p>
          ) : salesOpen ? (
            <form
              className="mt-3 grid gap-2 text-xs sm:grid-cols-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                if (await act({ action: "contactSales", company: form.get("company"), seats: Number(form.get("seats")) || undefined, message: form.get("message") })) setSalesOpen(false);
              }}
            >
              <input name="company" required placeholder="Company" aria-label="Company" className="rounded-lg border bg-transparent px-2 py-1.5" />
              <input name="seats" type="number" min={1} placeholder="Seats" aria-label="Seats" className="rounded-lg border bg-transparent px-2 py-1.5" />
              <button disabled={busy} className="btn-primary rounded-lg px-3 py-1.5 disabled:opacity-50">Send</button>
              <textarea name="message" placeholder="What do you need?" aria-label="What do you need?" rows={2} className="rounded-lg border bg-transparent px-2 py-1.5 sm:col-span-3" />
            </form>
          ) : (
            <button onClick={() => setSalesOpen(true)} className="mt-3 rounded-lg border px-3 py-1.5 text-xs">
              Contact sales
            </button>
          )}
        </div>
      </section>

      <section id="grants">
        <h2 className="mb-3 text-sm font-medium">Free allowances</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["Ask and Plan chats", `${Math.max(0, data.grants.chats.daily - data.grants.chats.usedToday)} of ${data.grants.chats.daily} left today`],
              ["Voice", `${Math.max(0, data.grants.voice.dailyMinutes - data.grants.voice.usedMinutes)} of ${data.grants.voice.dailyMinutes} minutes left today`],
              ["Monthly credits", `${data.grants.monthlyCredits} included each month`],
              ["Security fixes", "Scans, pentests and their fixes never use credits"],
            ] as const
          ).map(([k, v]) => (
            <li key={k} className={card} style={{ background: "var(--panel)" }}>
              <p className="text-xs" style={muted}>{k}</p>
              <p className="mt-0.5 text-sm font-medium">{v}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="usage">
        <h2 className="mb-3 text-sm font-medium">Usage breakdown this month</h2>
        {data.connectorRequests.length > 0 && (
          <p className="mb-3 text-xs" style={muted}>
            Connector requests (no credits): {data.connectorRequests.map((r) => `${r.kind} ${r.requests}`).join(" · ")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CATEGORIES.map(([key, label]) => (
            <div key={key} className="rounded-xl border px-4 py-3" style={{ background: "var(--panel)" }}>
              <p className="text-xs" style={muted}>
                {label}
              </p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">{data.usage.byCategory[key] ?? 0}</p>
            </div>
          ))}
        </div>
        <div className={`${card} mt-3`} style={{ background: "var(--panel)" }}>
          <DailyBars data={data.usage.daily} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className={card} style={{ background: "var(--panel)" }}>
            <h3 className="mb-2 text-xs font-medium">By project</h3>
            <Rows rows={data.usage.byProject.map((r) => ({ ...r, key: r.id ?? r.name }))} empty="No usage yet this month." />
          </div>
          <div className={card} style={{ background: "var(--panel)" }}>
            <h3 className="mb-2 text-xs font-medium">By member</h3>
            <Rows rows={data.usage.byUser.map((r) => ({ ...r, key: r.id ?? r.name }))} empty="No usage yet this month." />
          </div>
        </div>
      </section>

      <section id="limits">
        <h2 className="mb-1 text-sm font-medium">Spending limits</h2>
        <p className="mb-3 text-xs" style={muted}>
          Monthly caps. Building stops for whoever reaches one until it resets on the 1st or is raised.
        </p>
        <div className={card} style={{ background: "var(--panel)" }}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Workspace limit</span>
            <input
              value={wsLimit}
              onChange={(e) => setWsLimit(e.target.value.replace(/\D/g, ""))}
              disabled={!admin}
              placeholder="No limit"
              aria-label="Workspace monthly limit"
              inputMode="numeric"
              className="w-24 rounded-md border bg-transparent px-2 py-1 text-xs"
            />
            <span className="text-xs" style={muted}>
              credits / month
            </span>
            {admin && (
              <button
                disabled={busy}
                onClick={() => act({ action: "workspaceLimit", monthly: wsLimit ? Number(wsLimit) : null })}
                className="rounded-md border px-2 py-1 text-xs"
              >
                Save
              </button>
            )}
          </div>

          <ul className="mt-4 divide-y rounded-lg border" aria-label="Member and project limits">
            {data.limits.length === 0 && (
              <li className="px-3 py-2 text-xs" style={muted}>
                No member or project limits.
              </li>
            )}
            {data.limits.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="text-[10px] uppercase" style={muted}>
                    {l.scope === "user" ? "Member" : "Project"}
                  </span>{" "}
                  {l.name}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <span className="tabular-nums">
                    {l.spent} / {l.monthly}
                  </span>
                  {admin && (
                    <button onClick={() => act({ action: "removeLimit", id: l.id })} className="text-red-500 hover:underline">
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {admin && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <select
                value={limitForm.scope}
                onChange={(e) => setLimitForm({ scope: e.target.value, targetId: "", monthly: limitForm.monthly })}
                aria-label="Limit applies to"
                className="rounded-md border bg-transparent px-1.5 py-1"
              >
                <option value="user">Member</option>
                <option value="project">Project</option>
              </select>
              <select
                value={limitForm.targetId}
                onChange={(e) => setLimitForm({ ...limitForm, targetId: e.target.value })}
                aria-label={limitForm.scope === "user" ? "Member" : "Project"}
                className="min-w-0 max-w-48 rounded-md border bg-transparent px-1.5 py-1"
              >
                <option value="">Choose…</option>
                {(limitForm.scope === "user" ? data.members : data.projects).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input
                value={limitForm.monthly}
                onChange={(e) => setLimitForm({ ...limitForm, monthly: e.target.value.replace(/\D/g, "") })}
                placeholder="Credits / month"
                aria-label="Monthly credits"
                inputMode="numeric"
                className="w-28 rounded-md border bg-transparent px-2 py-1"
              />
              <button
                disabled={busy || !limitForm.targetId || !limitForm.monthly}
                onClick={async () => {
                  if (await act({ action: "setLimit", ...limitForm, monthly: Number(limitForm.monthly) })) {
                    setLimitForm({ ...limitForm, targetId: "", monthly: "" });
                  }
                }}
                className="rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-40"
                style={{ background: "var(--accent)" }}
              >
                Add limit
              </button>
            </div>
          )}
          {!admin && (
            <p className="mt-3 text-xs" style={muted}>
              Ask a workspace owner or admin to change limits.
            </p>
          )}
        </div>
      </section>

      <section id="plans">
        <h2 className="mb-3 text-sm font-medium">Plans</h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {PLANS.map((p) => {
            const active = p.id === data.plan;
            return (
              <li
                key={p.id}
                className="rounded-xl border p-4"
                style={{ background: "var(--panel)", borderColor: active ? "var(--accent)" : undefined }}
              >
                <p className="text-sm font-medium">{p.name}</p>
                <p className="mt-1 text-2xl font-semibold">{p.price}</p>
                <p className="mt-1 text-xs" style={muted}>
                  {p.credits} credits / month
                </p>
                <p className="mt-2 text-xs leading-relaxed" style={muted}>
                  {p.blurb}
                </p>
                <button
                  disabled={active || !admin || busy}
                  onClick={() => act({ action: "plan", plan: p.id })}
                  className="mt-3 w-full rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                >
                  {active ? "Current plan" : `Switch to ${p.name}`}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[11px]" style={muted}>
          Test mode: plan changes apply immediately without payment.
        </p>
      </section>
    </div>
  );
}
