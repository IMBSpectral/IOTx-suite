"use client";

import { useCallback, useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { Megaphone, Plus, Sparkles, Target } from "lucide-react";
import ChangesetCard from "./ChangesetCard";
import type { Campaign, Changeset, GrowthPlan } from "@/lib/marketing";

type CampaignView = Campaign & { problems: string[]; suggestions: { label: string; amount: number; note: string }[] };
type State = { plan: GrowthPlan | null; campaigns: CampaignView[]; changesets: Changeset[] };

const CHANNEL_LABEL: Record<string, string> = {
  search: "Search (SEO)",
  ads: "Ads",
  social: "Social",
  content: "Content",
  email: "Email",
  community: "Communities",
};
const TYPE_LABEL: Record<string, string> = {
  search: "Search",
  performance_max: "Performance Max",
  demand_gen: "Demand Gen",
  display: "Display",
  video: "Video",
  shopping: "Shopping",
};
const GOAL_LABEL: Record<string, string> = {
  sales: "Sales",
  leads: "Leads and sign-ups",
  website_traffic: "Website traffic",
  awareness: "Awareness",
};
const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));
const TARGET_IDEAS = ["First 100 signups", "1,000 visitors a month", "First 10 paying customers"];

/** Campaign chat actions: each asks the agent (Ask mode, so nothing in the app changes). */
const CHAT_ACTIONS = [
  { label: "Suggest ad improvements", prompt: (c: Campaign) => `Suggest ad improvements for my campaign "${c.name}" (${c.id}). Use list_campaigns, then propose the changes with propose_campaign_changes.` },
  { label: "Help me fix", prompt: (c: Campaign) => `Help me fix my campaign "${c.name}" (${c.id}) so it can launch. Use list_campaigns to see what's blocking it, and propose the fixes with propose_campaign_changes.` },
  { label: "Help me investigate", prompt: (c: Campaign) => `Help me investigate my campaign "${c.name}" (${c.id}): is the targeting, budget and bidding sensible for this app? Use list_campaigns.` },
  { label: "Create ad report", prompt: (c: Campaign) => `Create a short report on my campaign "${c.name}" (${c.id}): setup, ad copy quality, what's missing, and next steps. Use list_campaigns.` },
];

const muted = { color: "var(--muted)" };
const input = "w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-xs";

export default function MarketingPanel({
  projectId,
  onSend,
}: {
  projectId: string;
  onSend: (text: string, mode: "build" | "ask") => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const brand = useBrand();
  const [version, setVersion] = useState(0);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const base = `/api/projects/${projectId}/marketing`;
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) {
          setState(d);
          setTarget((t) => t || d.plan?.target || "");
        }
      });
    return () => {
      live = false;
    };
  }, [base, version]);

  async function post(action: string, body: Record<string, unknown>, label = action) {
    setBusy(label);
    setError(null);
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(d.error ?? "Something went wrong.");
      return null;
    }
    reload();
    return d;
  }

  if (!state) return <div className="p-5 text-xs" style={muted}>Loading…</div>;
  const pending = state.changesets.filter((c) => c.status === "pending");

  return (
    <div className="h-full space-y-6 overflow-y-auto p-5 text-sm">
      <div>
        <p className="flex items-center gap-1.5 font-medium">
          <Megaphone className="h-4 w-4" /> Grow your audience
        </p>
        <p className="mt-0.5 text-xs" style={muted}>
          Get deeper research and a tailored plan to bring more visitors, then run ads from here.
        </p>
      </div>
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}

      {/* Growth plan */}
      <section aria-label="Growth plan" className="space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void post("plan", { target }, "plan");
          }}
          className="flex gap-1.5"
        >
          <label className="flex flex-1 items-center gap-1.5 rounded-lg border px-2.5">
            <Target className="h-3.5 w-3.5 shrink-0" style={muted} />
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Set a target like 'first 100 signups'"
              aria-label="Growth target"
              className="w-full bg-transparent py-1.5 text-xs outline-none"
            />
          </label>
          <button
            disabled={!target.trim() || !!busy}
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            <Sparkles className="h-3 w-3" />
            {busy === "plan" ? "Researching…" : state.plan ? "New plan" : "Make a plan"}
          </button>
        </form>
        {!state.plan && (
          <div className="flex flex-wrap gap-1.5">
            {TARGET_IDEAS.map((t) => (
              <button key={t} onClick={() => setTarget(t)} className="rounded-full border px-2.5 py-0.5 text-xs">
                {t}
              </button>
            ))}
          </div>
        )}
        {state.plan && (
          <div className="space-y-3 rounded-xl border p-4" style={{ background: "var(--panel)" }}>
            <div>
              <p className="text-xs font-medium">Plan for: {state.plan.target}</p>
              <p className="mt-1 text-xs">{state.plan.summary}</p>
              <p className="mt-1 text-xs" style={muted}>
                Audience: {state.plan.audience}
              </p>
            </div>
            {state.plan.channels.map((ch) => (
              <div key={ch.channel}>
                <p className="text-xs font-medium">{CHANNEL_LABEL[ch.channel] ?? ch.channel}</p>
                <p className="text-xs" style={muted}>
                  {ch.why}
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {ch.actions.map((a) => (
                    <li key={a.id} className="flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={a.done}
                        onChange={(e) => void post("action_done", { actionId: a.id, done: e.target.checked }, `done:${a.id}`)}
                        aria-label={`Mark "${a.title}" done`}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <p className={a.done ? "line-through" : ""}>{a.title}</p>
                        <p style={muted}>{a.detail}</p>
                      </div>
                      {a.kind === "build" && a.prompt && !a.done && (
                        <button
                          onClick={() => {
                            onSend(a.prompt!, "build");
                            void post("action_done", { actionId: a.id, done: true }, `done:${a.id}`);
                          }}
                          className="shrink-0 rounded-md border px-2 py-0.5"
                        >
                          Build it
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Approvals */}
      {pending.length > 0 && (
        <section aria-label="Waiting for approval">
          <p className="text-xs font-medium">Waiting for your approval</p>
          {pending.map((cs) => (
            <ChangesetCard
              key={cs.id}
              projectId={projectId}
              changeset={cs}
              campaignName={state.campaigns.find((c) => c.id === cs.campaignId)?.name}
              onDecided={reload}
            />
          ))}
        </section>
      )}

      {/* Campaigns */}
      <section aria-label="Campaigns" className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium">Campaigns</p>
          {!wizard && (
            <button onClick={() => setWizard(true)} className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs">
              <Plus className="h-3 w-3" /> New campaign
            </button>
          )}
        </div>
        {wizard && (
          <CampaignWizard
            busy={busy === "create"}
            onCancel={() => setWizard(false)}
            onCreate={async (c) => {
              const d = await post("create_campaign", { campaign: c }, "create");
              if (d) setWizard(false);
            }}
          />
        )}
        {!wizard && state.campaigns.length === 0 && (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-xs" style={muted}>
            No campaigns yet. Create a Google Search campaign and {brand.shortName} writes the ads.
          </p>
        )}
        {state.campaigns.map((c) => (
          <div key={c.id} className="rounded-xl border p-4 text-xs" style={{ background: "var(--panel)" }}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{c.name}</p>
                <p style={muted}>
                  {c.platform === "google" ? "Google Ads" : "Meta Ads"} · {TYPE_LABEL[c.type]} · {GOAL_LABEL[c.goal]} ·{" "}
                  {c.dailyBudget} {c.currency}/day · {c.markets.join(", ") || "no markets"}
                </p>
              </div>
              <span className="rounded-full border px-2 py-0.5 capitalize">{c.status}</span>
            </div>
            {c.problems.length > 0 ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-amber-700">
                {c.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-emerald-700">Ready to launch once an ad account is connected.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button
                onClick={() => void post("draft_copy", { campaignId: c.id }, `copy:${c.id}`)}
                disabled={!!busy}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                <Sparkles className="h-3 w-3" />
                {busy === `copy:${c.id}` ? "Writing…" : c.headlines.length ? "Rewrite ads" : "Write ads"}
              </button>
              <button onClick={() => setPreview(preview === c.id ? null : c.id)} className="rounded-md border px-2.5 py-1">
                Preview my ads
              </button>
              {CHAT_ACTIONS.map((a) => (
                <button key={a.label} onClick={() => onSend(a.prompt(c), "ask")} className="rounded-md border px-2.5 py-1">
                  {a.label}
                </button>
              ))}
              <button
                onClick={() => void post("launch", { campaignId: c.id }, `launch:${c.id}`)}
                disabled={!!busy}
                className="rounded-md border px-2.5 py-1"
              >
                Launch
              </button>
              <button disabled title="Needs a connected ad account" className="rounded-md border px-2.5 py-1 opacity-50">
                Open ads analytics
              </button>
            </div>
            {preview === c.id && <AdPreview c={c} />}
          </div>
        ))}
      </section>
    </div>
  );
}

/** How a Google search ad renders: first three headlines, two descriptions. */
function AdPreview({ c }: { c: Campaign }) {
  if (!c.headlines.length) {
    return (
      <p className="mt-3 text-xs" style={muted}>
        No ads yet. Press Write ads first.
      </p>
    );
  }
  let host = c.finalUrl;
  try {
    host = new URL(c.finalUrl).host;
  } catch {}
  return (
    <div className="mt-3 rounded-lg border bg-white p-3 text-left text-[#202124]" aria-label="Ad preview">
      <p className="text-[11px]">
        <span className="font-semibold">Sponsored</span> · {host}
      </p>
      <p className="mt-0.5 text-base leading-snug text-[#1a0dab]">{c.headlines.slice(0, 3).join(" | ")}</p>
      <p className="mt-0.5 text-xs text-[#4d5156]">{c.descriptions.slice(0, 2).join(" ")}</p>
    </div>
  );
}

function CampaignWizard({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (c: Partial<Campaign>) => void;
}) {
  const brand = useBrand();
  const [c, setC] = useState({
    name: "",
    platform: "google" as Campaign["platform"],
    type: "search" as Campaign["type"],
    goal: "leads" as Campaign["goal"],
    markets: "US",
    languages: "en",
    dailyBudget: 0,
    currency: "USD",
    bidding: "max_conversions" as Campaign["bidding"],
    target: "",
    euPolitical: null as boolean | null,
    finalUrl: "",
  });
  const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K]) => setC((x) => ({ ...x, [k]: v }));
  const markets = c.markets.split(/[\s,]+/).map((m) => m.trim().toUpperCase()).filter(Boolean);
  const inEU = markets.some((m) => EU.has(m));
  const base = c.goal === "awareness" ? 10 : c.goal === "website_traffic" ? 15 : 25;
  const suggestions = [base, base * 2, base * 4];

  return (
    <form
      className="space-y-3 rounded-xl border p-4 text-xs"
      style={{ background: "var(--panel)" }}
      aria-label="New campaign"
      onSubmit={(e) => {
        e.preventDefault();
        const t = c.target ? Number(c.target) : null;
        onCreate({
          name: c.name,
          platform: c.platform,
          type: c.type,
          goal: c.goal,
          markets,
          languages: c.languages.split(/[\s,]+/).map((l) => l.trim().toLowerCase()).filter(Boolean),
          dailyBudget: c.dailyBudget,
          currency: c.currency,
          bidding: c.bidding,
          targetCpa: c.bidding === "max_conversions" ? t : null,
          targetRoas: c.bidding === "max_conversion_value" ? t : null,
          euPolitical: inEU ? c.euPolitical : null,
          finalUrl: c.finalUrl,
        });
      }}
    >
      <label className="block">
        Campaign name
        <input className={`${input} mt-1`} value={c.name} onChange={(e) => set("name", e.target.value)} placeholder="Spring launch" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label>
          Platform
          <select className={`${input} mt-1`} value={c.platform} onChange={(e) => set("platform", e.target.value as Campaign["platform"])}>
            <option value="google">Google Ads</option>
            <option value="meta">Meta (Facebook, Instagram)</option>
          </select>
        </label>
        <label>
          Campaign type
          <select className={`${input} mt-1`} value={c.type} onChange={(e) => set("type", e.target.value as Campaign["type"])}>
            {Object.entries(TYPE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset>
        <legend>What do you want from this campaign?</legend>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          {Object.entries(GOAL_LABEL).map(([v, l]) => (
            <label key={v} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 ${c.goal === v ? "border-[#6d4aff]" : ""}`}>
              <input type="radio" name="goal" checked={c.goal === v} onChange={() => set("goal", v as Campaign["goal"])} /> {l}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <label>
          Markets (country codes)
          <input className={`${input} mt-1`} value={c.markets} onChange={(e) => set("markets", e.target.value)} placeholder="US, GB, DE" />
        </label>
        <label>
          Languages
          <input className={`${input} mt-1`} value={c.languages} onChange={(e) => set("languages", e.target.value)} placeholder="en, de" />
        </label>
      </div>
      <fieldset>
        <legend>Daily budget ({c.currency})</legend>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {suggestions.map((s, i) => (
            <button
              type="button"
              key={s}
              onClick={() => set("dailyBudget", s)}
              className={`rounded-lg border px-2.5 py-1 ${c.dailyBudget === s ? "border-[#6d4aff] font-medium" : ""}`}
            >
              {s}
              {i === 1 ? " · Recommended" : ""}
            </button>
          ))}
          <input
            type="number"
            min={1}
            aria-label="Custom daily budget"
            className="w-24 rounded-lg border bg-transparent px-2 py-1"
            value={c.dailyBudget || ""}
            onChange={(e) => set("dailyBudget", Number(e.target.value))}
            placeholder="Custom"
          />
        </div>
        <p className="mt-1" style={muted}>
          {brand.shortName}&apos;s suggestion: enough spend to learn which ads work within about two weeks.
        </p>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <label>
          Bidding focus
          <select className={`${input} mt-1`} value={c.bidding} onChange={(e) => set("bidding", e.target.value as Campaign["bidding"])}>
            <option value="max_conversions">Maximize conversions</option>
            <option value="max_conversion_value">Maximize conversion value</option>
            <option value="max_clicks">Maximize clicks</option>
          </select>
        </label>
        {c.bidding !== "max_clicks" && (
          <label>
            {c.bidding === "max_conversions" ? "Target cost per action (optional)" : "Target ROAS % (optional)"}
            <input type="number" min={0} className={`${input} mt-1`} value={c.target} onChange={(e) => set("target", e.target.value)} />
          </label>
        )}
      </div>
      <label className="block">
        Landing page
        <input className={`${input} mt-1`} value={c.finalUrl} onChange={(e) => set("finalUrl", e.target.value)} placeholder="Your published site (default)" />
      </label>
      {inEU && (
        <fieldset>
          <legend>Do these ads contain EU political advertising?</legend>
          <div className="mt-1 flex gap-3">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="political" checked={c.euPolitical === false} onChange={() => set("euPolitical", false)} /> No
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="political" checked={c.euPolitical === true} onChange={() => set("euPolitical", true)} /> Yes
            </label>
          </div>
        </fieldset>
      )}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="rounded-lg border px-3 py-1.5">
          Cancel
        </button>
        <button disabled={busy} className="rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-50" style={{ background: "var(--accent)" }}>
          {busy ? "Saving…" : "Save draft"}
        </button>
      </div>
    </form>
  );
}
