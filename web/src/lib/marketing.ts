import crypto from "node:crypto";
import { getBrand } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { db } from "./db";
import { PROJECTS_ROOT } from "./paths";
import { listFiles, readFile } from "./repo";
import { siteAnalytics } from "./projects";
import { charge, creditsForUsage } from "./credits";
import { siteOrigin } from "./site-host";
import { consultProject } from "./kb";
import { meteredFetch } from "./ai-meter";

/**
 * The marketing agent: a growth plan aimed at a target ("first 100 signups"),
 * ad campaigns drafted in Forge, and changesets — every change to a campaign
 * is proposed as Before/After fields and applied only on approval.
 *
 * Campaigns live as drafts until an ad account is connected; launching and
 * syncing live campaigns need the Google Ads / Meta connectors, which aren't
 * available yet, so those paths fail with a clear reason instead of pretending.
 */

const workspaceHeader = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({ ...(workspaceHeader ? { defaultHeaders: { "anthropic-workspace-id": workspaceHeader } } : {}), fetch: meteredFetch("Marketing") });
const MODEL = "claude-opus-5-5";

export class MarketingError extends Error {}

// ── Types ───────────────────────────────────────────────────────

export const CHANNELS = ["search", "ads", "social", "content", "email", "community"] as const;
export const CAMPAIGN_TYPES = ["search", "performance_max", "demand_gen", "display", "video", "shopping"] as const;
export const CAMPAIGN_GOALS = ["sales", "leads", "website_traffic", "awareness"] as const;
export const BIDDING = ["max_conversions", "max_conversion_value", "max_clicks"] as const;

export type PlanAction = { id: string; title: string; detail: string; kind: "build" | "manual"; prompt?: string; done: boolean };
export type GrowthPlan = {
  target: string;
  createdAt: string;
  summary: string;
  audience: string;
  channels: { channel: (typeof CHANNELS)[number]; why: string; actions: PlanAction[] }[];
};

export type Campaign = {
  id: string;
  platform: "google" | "meta";
  type: (typeof CAMPAIGN_TYPES)[number];
  name: string;
  status: "draft" | "live" | "paused" | "removed";
  goal: (typeof CAMPAIGN_GOALS)[number];
  markets: string[];
  languages: string[];
  dailyBudget: number;
  currency: string;
  bidding: (typeof BIDDING)[number];
  targetCpa: number | null;
  targetRoas: number | null;
  euPolitical: boolean | null;
  finalUrl: string;
  headlines: string[];
  descriptions: string[];
  keywords: string[];
  createdAt: string;
  updatedAt: string;
};

/** Fields a changeset may touch, in the order the approval card shows them. */
export const EDITABLE = [
  "name", "headlines", "descriptions", "keywords", "markets", "languages",
  "dailyBudget", "bidding", "targetCpa", "targetRoas", "finalUrl", "status",
] as const;
type Field = (typeof EDITABLE)[number];

export type Change = { field: Field; before: unknown; after: unknown };
export type Outcome = "applied" | "partial" | "failed" | "skipped" | "unconfirmed";
export type Changeset = {
  id: string;
  campaignId: string;
  createdAt: string;
  source: "agent" | "user";
  summary: string;
  changes: Change[];
  status: "pending" | "rejected" | Outcome;
  results?: { field: Field; outcome: "applied" | "failed" | "skipped"; reason?: string }[];
  decidedAt?: string;
};

type Store = { plan: GrowthPlan | null; campaigns: Campaign[]; changesets: Changeset[] };

// ── Store ───────────────────────────────────────────────────────

const storeFile = (projectId: string) => path.join(PROJECTS_ROOT, "_marketing", `${projectId}.json`);

export async function readStore(projectId: string): Promise<Store> {
  const raw = await fs.readFile(storeFile(projectId), "utf8").catch(() => null);
  const s = raw ? (JSON.parse(raw) as Partial<Store>) : {};
  return { plan: s.plan ?? null, campaigns: s.campaigns ?? [], changesets: s.changesets ?? [] };
}

async function writeStore(projectId: string, s: Store) {
  await fs.mkdir(path.dirname(storeFile(projectId)), { recursive: true });
  const tmp = `${storeFile(projectId)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2));
  await fs.rename(tmp, storeFile(projectId));
}

export async function purgeMarketing(projectId: string) {
  await fs.rm(storeFile(projectId), { force: true });
}

// ── Validation (Google Ads' own limits) ─────────────────────────

const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));
export const HEADLINE_MAX = 30;
export const DESCRIPTION_MAX = 90;

/** Problems that block launching; a draft may still be saved with them. */
export function campaignProblems(c: Campaign): string[] {
  const p: string[] = [];
  if (!c.name.trim()) p.push("Give the campaign a name.");
  if (!c.markets.length) p.push("Choose at least one market.");
  if (!c.languages.length) p.push("Choose at least one language.");
  if (!(c.dailyBudget >= 1)) p.push("The daily budget must be at least 1.");
  if (!/^https?:\/\/\S+$/.test(c.finalUrl)) p.push("The landing page must be a full http(s) URL.");
  if (c.markets.some((m) => EU.has(m)) && c.euPolitical === null) {
    p.push("Declare whether the ads are political (required when targeting the EU).");
  }
  if (c.euPolitical) p.push(`Political ads need extra verification that ${getBrand().shortName} can't do; they can't be launched from here.`);
  if (c.targetCpa !== null && c.bidding !== "max_conversions") p.push("A target CPA only applies to Maximize conversions.");
  if (c.targetRoas !== null && c.bidding !== "max_conversion_value") p.push("A target ROAS only applies to Maximize conversion value.");
  if (c.type === "search") {
    if (c.headlines.length < 3) p.push("Search ads need at least 3 headlines.");
    if (c.descriptions.length < 2) p.push("Search ads need at least 2 descriptions.");
    if (!c.keywords.length) p.push("Add at least one keyword.");
  }
  return p;
}

/** Hard rules every saved campaign must meet (lengths, counts, enums). */
function assertShape(c: Campaign) {
  if (c.headlines.length > 15) throw new MarketingError("At most 15 headlines.");
  if (c.descriptions.length > 4) throw new MarketingError("At most 4 descriptions.");
  if (c.keywords.length > 200) throw new MarketingError("At most 200 keywords.");
  const long = c.headlines.find((h) => h.length > HEADLINE_MAX);
  if (long) throw new MarketingError(`Headline "${long}" is over ${HEADLINE_MAX} characters.`);
  const longD = c.descriptions.find((d) => d.length > DESCRIPTION_MAX);
  if (longD) throw new MarketingError(`A description is over ${DESCRIPTION_MAX} characters.`);
  if (!CAMPAIGN_TYPES.includes(c.type)) throw new MarketingError("Unknown campaign type.");
  if (!CAMPAIGN_GOALS.includes(c.goal)) throw new MarketingError("Unknown campaign goal.");
  if (!BIDDING.includes(c.bidding)) throw new MarketingError("Unknown bidding strategy.");
  if (!(c.dailyBudget >= 0 && c.dailyBudget <= 1_000_000)) throw new MarketingError("Daily budget is out of range.");
  if (c.markets.some((m) => !/^[A-Z]{2}$/.test(m))) throw new MarketingError("Markets are 2-letter country codes.");
  if (c.languages.some((l) => !/^[a-z]{2}$/.test(l))) throw new MarketingError("Languages are 2-letter codes.");
  if (c.targetRoas !== null && !(c.targetRoas > 0)) throw new MarketingError("Target ROAS must be positive.");
  if (c.targetCpa !== null && !(c.targetCpa > 0)) throw new MarketingError("Target CPA must be positive.");
}

/** Forge's budget suggestions: what it takes to get meaningful data in about two weeks. */
export function budgetSuggestions(goal: Campaign["goal"]) {
  const base = goal === "awareness" ? 10 : goal === "website_traffic" ? 15 : 25;
  return [
    { label: "Test", amount: base, note: "Enough to learn which ads work" },
    { label: "Recommended", amount: base * 2, note: "Steady results within two weeks" },
    { label: "Growth", amount: base * 4, note: "More reach once ads are proven" },
  ];
}

// ── Campaigns ───────────────────────────────────────────────────

const clean = (a: unknown, max: number) =>
  (Array.isArray(a) ? a : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max);

async function defaultUrl(projectId: string) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { subdomain: true, customDomain: true } });
  return p.customDomain ? `https://${p.customDomain}` : siteOrigin(p.subdomain);
}

export async function createCampaign(projectId: string, input: Partial<Campaign>) {
  const now = new Date().toISOString();
  const c: Campaign = {
    id: crypto.randomUUID(),
    platform: input.platform === "meta" ? "meta" : "google",
    type: input.type ?? "search",
    name: (input.name ?? "").trim().slice(0, 120) || "New campaign",
    status: "draft",
    goal: input.goal ?? "leads",
    markets: clean(input.markets, 50).map((m) => m.toUpperCase()),
    languages: clean(input.languages, 20).map((l) => l.toLowerCase()),
    dailyBudget: Number(input.dailyBudget ?? 0),
    currency: /^[A-Z]{3}$/.test(input.currency ?? "") ? input.currency! : "USD",
    bidding: input.bidding ?? "max_conversions",
    targetCpa: input.targetCpa ?? null,
    targetRoas: input.targetRoas ?? null,
    euPolitical: typeof input.euPolitical === "boolean" ? input.euPolitical : null,
    finalUrl: (input.finalUrl ?? "").trim() || (await defaultUrl(projectId)),
    headlines: clean(input.headlines, 15),
    descriptions: clean(input.descriptions, 4),
    keywords: clean(input.keywords, 200),
    createdAt: now,
    updatedAt: now,
  };
  assertShape(c);
  const s = await readStore(projectId);
  if (s.campaigns.filter((x) => x.status !== "removed").length >= 50) throw new MarketingError("A project can have up to 50 campaigns.");
  s.campaigns.push(c);
  await writeStore(projectId, s);
  return c;
}

/** Launching needs a connected ad account; none can be connected yet, so this says so plainly. */
export async function launchCampaign(projectId: string, campaignId: string) {
  const s = await readStore(projectId);
  const c = s.campaigns.find((x) => x.id === campaignId);
  if (!c) throw new MarketingError("Campaign not found.");
  const problems = campaignProblems(c);
  if (problems.length) throw new MarketingError(problems[0]);
  throw new MarketingError(
    `Connect a ${c.platform === "google" ? "Google Ads" : "Meta Ads"} account to launch. The campaign is saved as a draft and ready to go.`,
  );
}

// ── Changesets ──────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A proposed value in the field's own type, or an error naming the field. */
function coerce(field: Field, v: unknown): unknown {
  const bad = () => new MarketingError(`"${field}" has the wrong type.`);
  switch (field) {
    case "headlines":
    case "descriptions":
    case "keywords":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad();
      return clean(v, 200);
    case "markets":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad();
      return clean(v, 50).map((m) => m.toUpperCase());
    case "languages":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad();
      return clean(v, 20).map((l) => l.toLowerCase());
    case "dailyBudget":
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad();
      return v;
    case "targetCpa":
    case "targetRoas":
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw bad();
      return v;
    case "status":
      if (!["draft", "live", "paused", "removed"].includes(v as string)) throw bad();
      return v;
    default:
      if (typeof v !== "string") throw bad();
      return v.trim();
  }
}

export async function proposeChanges(
  projectId: string,
  campaignId: string,
  summary: string,
  patch: Partial<Record<Field, unknown>>,
  source: Changeset["source"],
) {
  const s = await readStore(projectId);
  const c = s.campaigns.find((x) => x.id === campaignId && x.status !== "removed");
  if (!c) throw new MarketingError("Campaign not found.");
  const changes: Change[] = [];
  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    const after = coerce(field, patch[field]);
    if (!same(c[field], after)) changes.push({ field, before: c[field], after });
  }
  if (!changes.length) throw new MarketingError("Those changes match the campaign as it is.");
  // Check the result is valid before anyone is asked to approve it.
  assertShape({ ...c, ...Object.fromEntries(changes.map((ch) => [ch.field, ch.after])) } as Campaign);
  const cs: Changeset = {
    id: crypto.randomUUID(),
    campaignId,
    createdAt: new Date().toISOString(),
    source,
    summary: summary.trim().slice(0, 300) || "Proposed changes",
    changes,
    status: "pending",
  };
  s.changesets.push(cs);
  await writeStore(projectId, s);
  return cs;
}

/**
 * Apply an approved changeset. Each field is applied on its own: a field
 * whose "before" no longer matches (the campaign changed since) is skipped,
 * so approving a stale proposal can't silently overwrite newer edits.
 */
export async function decideChangeset(projectId: string, changesetId: string, approve: boolean) {
  const s = await readStore(projectId);
  const cs = s.changesets.find((x) => x.id === changesetId);
  if (!cs) throw new MarketingError("Changeset not found.");
  if (cs.status !== "pending") throw new MarketingError("This changeset was already decided.");
  cs.decidedAt = new Date().toISOString();
  if (!approve) {
    cs.status = "rejected";
    await writeStore(projectId, s);
    return cs;
  }
  const c = s.campaigns.find((x) => x.id === cs.campaignId);
  if (!c || c.status === "removed") {
    cs.status = "failed";
    cs.results = cs.changes.map((ch) => ({ field: ch.field, outcome: "failed", reason: "The campaign was removed." }));
    await writeStore(projectId, s);
    return cs;
  }
  cs.results = [];
  for (const ch of cs.changes) {
    if (!same(c[ch.field], ch.before)) {
      cs.results.push({ field: ch.field, outcome: "skipped", reason: "Changed since this was proposed." });
      continue;
    }
    if (c.status === "live") {
      // A live campaign is changed on the ad platform, which needs its connector.
      cs.results.push({ field: ch.field, outcome: "failed", reason: "The ad account isn't connected." });
      continue;
    }
    if (ch.field === "status" && ch.after === "live") {
      cs.results.push({ field: ch.field, outcome: "failed", reason: "Launching needs a connected ad account." });
      continue;
    }
    (c as Record<string, unknown>)[ch.field] = ch.after;
    cs.results.push({ field: ch.field, outcome: "applied" });
  }
  const applied = cs.results.filter((r) => r.outcome === "applied").length;
  cs.status = applied === cs.results.length ? "applied" : applied ? "partial" : cs.results.every((r) => r.outcome === "skipped") ? "skipped" : "failed";
  if (applied) c.updatedAt = new Date().toISOString();
  await writeStore(projectId, s);
  return cs;
}

// ── AI: growth plan and ad copy ─────────────────────────────────

/** What the model needs to know about the app, kept small. */
async function appBrief(projectId: string) {
  const p = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, publishedSha: true, subdomain: true, customDomain: true, knowledge: true },
  });
  const files = await listFiles(projectId);
  const pick = ["index.html", "src/App.tsx", ...files.filter((f) => /^src\/pages\/[^/]+\.tsx$/.test(f)).slice(0, 4)];
  const parts: string[] = [];
  for (const f of pick) {
    const t = await readFile(projectId, f).catch(() => null);
    if (t) parts.push(`<file path="${f}">\n${t.slice(0, 6000)}\n</file>`);
  }
  const visits = p.publishedSha ? await siteAnalytics(projectId, 30) : null;
  return {
    name: p.name,
    url: p.publishedSha ? await defaultUrl(projectId) : null,
    text:
      `App: ${p.name}\n` +
      `Published: ${p.publishedSha ? `yes, ${visits?.last7 ?? 0} visits in the last 7 days, ${visits?.total ?? 0} in 30` : "not yet"}\n` +
      (p.knowledge?.content.trim() ? `Project knowledge: ${p.knowledge.content.slice(0, 2000)}\n` : "") +
      `Pages: ${files.filter((f) => f.startsWith("src/pages/")).join(", ") || "single page"}\n\n` +
      parts.join("\n\n"),
  };
}

const PlanSchema = z.object({
  summary: z.string().describe("Two or three sentences: where the app stands and the strategy to reach the target"),
  audience: z.string().describe("Who to reach, as specifically as the app allows"),
  channels: z
    .array(
      z.object({
        channel: z.enum(CHANNELS),
        why: z.string(),
        actions: z
          .array(
            z.object({
              title: z.string().describe("Imperative, under 60 characters"),
              detail: z.string().describe("One or two sentences on exactly what to do"),
              kind: z.enum(["build", "manual"]).describe("build = a change to this app the agent can make; manual = something the person does"),
              prompt: z.string().describe("For build actions: the exact instruction to give the agent. Empty for manual."),
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .min(2)
    .max(5),
});

const PLAN_SYSTEM = `You are a pragmatic growth marketer for small web apps built with an AI app builder. Given the app's code and a target, write a focused plan to hit the target.

Rules:
- Be specific to this app: name the audience, the search terms people would use, the communities where they are.
- Order channels by expected impact for this app and budget. Two to four channels is usually right.
- Prefer actions that improve the app itself (kind "build"): SEO titles and meta descriptions, Open Graph tags, a sharper headline, a clear call to action, a signup or waitlist form, analytics events on the conversion. Give each one a precise prompt.
- Manual actions must be concrete ("Post a 30-second demo in r/smallbusiness with the title …"), never generic advice.
- Never invent numbers about the app's traffic beyond what you are told.`;

export async function generatePlan(opts: { projectId: string; workspaceId: string; userId: string; target: string }) {
  const target = opts.target.trim().slice(0, 200);
  if (!target) throw new MarketingError("Set a target, like 'first 100 signups'.");
  const brief = await appBrief(opts.projectId);
  // Knowledge first: the company's own products, prices and customers shape the plan.
  const company = await consultProject(opts.projectId, opts.userId, `${target} marketing customers`, { context: brief.name, cite: false });
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(PlanSchema) },
    system: company.context ? `${PLAN_SYSTEM}\n\n${company.context}` : PLAN_SYSTEM,
    messages: [{ role: "user", content: `Target: ${target}\n\n${brief.text}` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new MarketingError("Couldn't write a plan for this app.");
  const out = response.parsed_output;
  const plan: GrowthPlan = {
    target,
    createdAt: new Date().toISOString(),
    summary: out.summary,
    audience: out.audience,
    channels: out.channels.map((c) => ({
      channel: c.channel,
      why: c.why,
      actions: c.actions.map((a) => ({
        id: crypto.randomUUID(),
        title: a.title,
        detail: a.detail,
        kind: a.kind,
        prompt: a.kind === "build" && a.prompt.trim() ? a.prompt.trim() : undefined,
        done: false,
      })),
    })),
  };
  const s = await readStore(opts.projectId);
  s.plan = plan;
  await writeStore(opts.projectId, s);
  await charge(opts.workspaceId, creditsForUsage(response.usage.input_tokens, response.usage.output_tokens), "GENERATION", undefined, {
    category: "chat",
    userId: opts.userId,
    projectId: opts.projectId,
  });
  return plan;
}

export async function setActionDone(projectId: string, actionId: string, done: boolean) {
  const s = await readStore(projectId);
  const a = s.plan?.channels.flatMap((c) => c.actions).find((x) => x.id === actionId);
  if (!a) throw new MarketingError("Action not found.");
  a.done = done;
  await writeStore(projectId, s);
  return a;
}

const CopySchema = z.object({
  summary: z.string().describe("One sentence on what changed and why"),
  headlines: z.array(z.string()).min(3).max(15),
  descriptions: z.array(z.string()).min(2).max(4),
  keywords: z.array(z.string()).min(3).max(30),
});

/**
 * Write (or improve) a campaign's ad copy and keywords, returned as a
 * changeset for approval. Over-long lines are dropped rather than trimmed
 * mid-word, so what's approved is exactly what the model wrote.
 */
export async function draftAdCopy(opts: { projectId: string; workspaceId: string; userId: string; campaignId: string; instruction?: string }) {
  const s = await readStore(opts.projectId);
  const c = s.campaigns.find((x) => x.id === opts.campaignId && x.status !== "removed");
  if (!c) throw new MarketingError("Campaign not found.");
  const brief = await appBrief(opts.projectId);
  // Knowledge first: ad claims (prices, terms, products) must match the company's articles.
  const company = await consultProject(opts.projectId, opts.userId, opts.instruction || `${c.goal} ${c.keywords.slice(0, 5).join(" ")}`, { context: brief.name, cite: false });
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: zodOutputFormat(CopySchema) },
    system:
      `You write Google search ads. Headlines are at most ${HEADLINE_MAX} characters each, descriptions at most ` +
      `${DESCRIPTION_MAX}. Count characters carefully. Be concrete about what the app does and who it's for; include ` +
      `a call to action. Keywords are phrases people would search, without match-type symbols.` +
      (company.context ? `\n\n${company.context}` : ""),
    messages: [
      {
        role: "user",
        content:
          `Campaign goal: ${c.goal}. Markets: ${c.markets.join(", ") || "not set"}. Languages: ${c.languages.join(", ") || "en"}.\n` +
          `Current headlines: ${JSON.stringify(c.headlines)}\nCurrent descriptions: ${JSON.stringify(c.descriptions)}\n` +
          `Current keywords: ${JSON.stringify(c.keywords)}\n` +
          (opts.instruction ? `Request: ${opts.instruction}\n` : "Write strong copy for this campaign.\n") +
          `\n${brief.text}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new MarketingError("Couldn't write ad copy.");
  const out = response.parsed_output;
  await charge(opts.workspaceId, creditsForUsage(response.usage.input_tokens, response.usage.output_tokens), "GENERATION", undefined, {
    category: "chat",
    userId: opts.userId,
    projectId: opts.projectId,
  });
  const headlines = [...new Set(out.headlines.map((h) => h.trim()).filter((h) => h && h.length <= HEADLINE_MAX))].slice(0, 15);
  const descriptions = [...new Set(out.descriptions.map((d) => d.trim()).filter((d) => d && d.length <= DESCRIPTION_MAX))].slice(0, 4);
  const keywords = [...new Set(out.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
  return proposeChanges(opts.projectId, c.id, out.summary, { headlines, descriptions, keywords }, "agent");
}
