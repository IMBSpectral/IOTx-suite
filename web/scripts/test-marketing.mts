/**
 * Marketing agent over the API: campaign drafts with Google Ads' limits,
 * launch blockers, changesets (type checks, Before/After, approve, reject,
 * stale fields skipped, partial outcome), launch refused without an ad
 * account, and the two model calls (growth plan, ad copy as a changeset).
 * Uses a throwaway project that is permanently deleted at the end, and checks
 * its marketing data is purged with it.
 *   npx tsx scripts/test-marketing.mts <devToken>
 */
import fs from "node:fs";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT ?? "D:/ImbSpectral/REA-V1/projects-data";
const [token] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function call(path: string, json?: unknown, method?: string) {
  const res = await fetch(BASE + path, {
    method: method ?? (json === undefined ? "GET" : "POST"),
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

let pid = "";

async function main() {
  const app = await call("/api/projects", { name: "Marketing test app" });
  pid = app.body.project?.id;
  check("app created", app.status === 201 && !!pid);
  const M = `/api/projects/${pid}/marketing`;
  const get = async () => (await call(M)).body;

  check("starts empty", (await get()).campaigns.length === 0 && (await get()).plan === null);

  // ── Campaign drafts ──────────────────────────────────────────
  check("over-long headline refused", (await call(M, { action: "create_campaign", campaign: { headlines: ["x".repeat(31)] } })).status === 400);
  check("bad market code refused", (await call(M, { action: "create_campaign", campaign: { markets: ["USA"] } })).status === 400);
  check("unknown type refused", (await call(M, { action: "create_campaign", campaign: { type: "billboard" } })).status === 400);

  const c1 = await call(M, {
    action: "create_campaign",
    campaign: { name: "Launch", markets: ["us", "DE"], languages: ["EN"], dailyBudget: 20, bidding: "max_conversions", targetRoas: 300 },
  });
  check("draft saved", c1.status === 201 && c1.body.campaign.status === "draft");
  const id = c1.body.campaign.id as string;
  check("codes normalised", c1.body.campaign.markets.join() === "US,DE" && c1.body.campaign.languages.join() === "en");
  check("landing page defaults to the site", /^https?:\/\//.test(c1.body.campaign.finalUrl), c1.body.campaign.finalUrl);
  let view = (await get()).campaigns.find((c: any) => c.id === id);
  const has = (s: string) => view.problems.some((p: string) => p.includes(s));
  check("EU market needs a political declaration", has("political"));
  check("ROAS with max conversions flagged", has("target ROAS"));
  check("search ads need headlines", has("3 headlines"));
  check("budget suggestions offered", view.suggestions.length === 3 && view.suggestions[1].label === "Recommended");

  // ── Changesets ───────────────────────────────────────────────
  check("wrong type refused", (await call(M, { action: "propose", campaignId: id, patch: { headlines: "not a list" } })).status === 400);
  check("no-op refused", (await call(M, { action: "propose", campaignId: id, patch: { dailyBudget: 20 } })).status === 400);
  check("invalid result refused before approval", (await call(M, { action: "propose", campaignId: id, patch: { descriptions: ["y".repeat(91), "ok"] } })).status === 400);
  check("unknown campaign refused", (await call(M, { action: "propose", campaignId: "nope", patch: { dailyBudget: 5 } })).status === 400);

  const fix = await call(M, {
    action: "propose",
    campaignId: id,
    summary: "Fix launch blockers",
    patch: {
      headlines: ["Plan meals in minutes", "Free weekly meal plans", "Cook more, waste less"],
      descriptions: ["Get a week of recipes and a shopping list in one tap.", "Start free today."],
      keywords: ["meal planner", "weekly meal plan"],
      targetRoas: null,
      dailyBudget: 40,
    },
  });
  check("changeset proposed", fix.status === 201 && fix.body.changeset.status === "pending");
  const ch = fix.body.changeset;
  const budget = ch.changes.find((c: any) => c.field === "dailyBudget");
  check("Before/After recorded", budget?.before === 20 && budget?.after === 40 && ch.changes.length === 5);
  view = (await get()).campaigns.find((c: any) => c.id === id);
  check("nothing changes before approval", view.dailyBudget === 20 && view.headlines.length === 0);

  const ok = await call(M, { action: "decide", changesetId: ch.id, approve: true });
  check("approved → applied", ok.body.changeset.status === "applied" && ok.body.changeset.results.every((r: any) => r.outcome === "applied"));
  view = (await get()).campaigns.find((c: any) => c.id === id);
  check("campaign updated", view.dailyBudget === 40 && view.headlines.length === 3 && view.targetRoas === null);
  check("can't decide twice", (await call(M, { action: "decide", changesetId: ch.id, approve: false })).status === 400);

  const rej = await call(M, { action: "propose", campaignId: id, summary: "Halve budget", patch: { dailyBudget: 20 } });
  check("rejected", (await call(M, { action: "decide", changesetId: rej.body.changeset.id, approve: false })).body.changeset.status === "rejected");
  check("rejected change not applied", (await get()).campaigns.find((c: any) => c.id === id).dailyBudget === 40);

  // Two proposals on the same field: approving the second after the first lands is stale.
  const a = await call(M, { action: "propose", campaignId: id, summary: "Budget 50", patch: { dailyBudget: 50, name: "Launch v2" } });
  const b = await call(M, { action: "propose", campaignId: id, summary: "Budget 60", patch: { dailyBudget: 60 } });
  await call(M, { action: "decide", changesetId: a.body.changeset.id, approve: true });
  const stale = await call(M, { action: "decide", changesetId: b.body.changeset.id, approve: true });
  check("stale field skipped", stale.body.changeset.status === "skipped" && stale.body.changeset.results[0].reason.includes("Changed since"));
  check("newer value kept", (await get()).campaigns.find((c: any) => c.id === id).dailyBudget === 50);

  const mixed = await call(M, { action: "propose", campaignId: id, summary: "Go live", patch: { status: "live", name: "Launch v3" } });
  const mixedOut = await call(M, { action: "decide", changesetId: mixed.body.changeset.id, approve: true });
  check("going live needs an account → partial", mixedOut.body.changeset.status === "partial");
  check("other field still applied", (await get()).campaigns.find((c: any) => c.id === id).name === "Launch v3");

  // ── Launch ───────────────────────────────────────────────────
  const blocked = await call(M, { action: "launch", campaignId: id });
  check("launch blocked by first problem", blocked.status === 400 && blocked.body.error.includes("political"), blocked.body.error);
  await call(M, { action: "decide", changesetId: (await call(M, { action: "propose", campaignId: id, summary: "US only", patch: { markets: ["US"] } })).body.changeset.id, approve: true });
  view = (await get()).campaigns.find((c: any) => c.id === id);
  check("no problems left", view.problems.length === 0, view.problems.join("; "));
  const noAccount = await call(M, { action: "launch", campaignId: id });
  check("launch needs a connected account", noAccount.status === 400 && noAccount.body.error.includes("Connect a Google Ads account"));

  // ── Model calls ──────────────────────────────────────────────
  check("empty target refused", (await call(M, { action: "plan", target: "  " })).status === 400);
  const plan = await call(M, { action: "plan", target: "first 100 signups" });
  const p = plan.body.plan;
  check("growth plan written", plan.status === 200 && p?.target === "first 100 signups" && p.channels.length >= 2, `status ${plan.status}`);
  const actions = p?.channels.flatMap((c: any) => c.actions) ?? [];
  check("plan has build actions with prompts", actions.some((x: any) => x.kind === "build" && x.prompt));
  check("action can be ticked", (await call(M, { action: "action_done", actionId: actions[0]?.id, done: true })).body.action?.done === true);

  const copy = await call(M, { action: "draft_copy", campaignId: id, instruction: "Emphasise that it's free." });
  const cs = copy.body.changeset;
  check("ad copy proposed as a changeset", copy.status === 201 && cs?.source === "agent" && cs.status === "pending", copy.body.error ?? "");
  const hl = cs?.changes.find((c: any) => c.field === "headlines")?.after ?? [];
  check("headlines within 30 chars", hl.length >= 3 && hl.every((h: string) => h.length <= 30), `${hl.length} headlines`);
  const ds = cs?.changes.find((c: any) => c.field === "descriptions")?.after ?? [];
  check("descriptions within 90 chars", ds.length >= 2 && ds.every((d: string) => d.length <= 90));
}

main()
  .catch((e) => {
    console.log("FAIL crashed —", e);
    failures++;
  })
  .finally(async () => {
    if (pid) {
      await call(`/api/projects/${pid}?permanent=1`, undefined, "DELETE");
      check("marketing data purged with the project", !fs.existsSync(`${ROOT}/_marketing/${pid}.json`));
    }
    console.log(failures ? `\n${failures} failed` : "\nAll passed");
    process.exit(failures ? 1 : 0);
  });
