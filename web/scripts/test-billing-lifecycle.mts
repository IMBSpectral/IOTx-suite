/**
 * Credits and project lifecycle: billing periods (refill, rollover, expiry),
 * expiry nudges, the out-of-credits pause date, the free build hour, spending
 * order, abandoned-project clean-up with Keep it / Protect it, zipped-folder
 * archives, automation webhooks, retired templates, and the billing guards
 * (usage terms, voice needs credits). Library checks run against a throwaway
 * workspace; HTTP checks need the server and a dev session token.
 *   npx tsx scripts/test-billing-lifecycle.mts <devToken>
 */
import "dotenv/config";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import { addMonth, creditSummary, expiryNudge, refreshCredits } from "../src/lib/billing-cycle";
import { charge, freeBuildHour, grant, spentThisMonth } from "../src/lib/credits";
import { answerCleanup, ABANDONED_DAYS, GRACE_DAYS, sweepAbandoned } from "../src/lib/housekeeping";
import { extractAll, listing, openArchive, readEntry } from "../src/lib/archives";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const DAY = 86_400_000;
const wsIds: string[] = [];
async function workspace(plan: "FREE" | "PRO", balance: number, monthly: number, periodStart: Date) {
  const ws = await db.workspace.create({
    data: { name: "Billing test", slug: `billing-test-${Math.random().toString(36).slice(2, 10)}`, plan, creditBalance: balance, monthlyCredits: monthly, periodStart },
  });
  wsIds.push(ws.id);
  return ws.id;
}
const get = (id: string) => db.workspace.findUniqueOrThrow({ where: { id } });

let pid = "";
let autoId = "";
try {
  // ── Billing periods ──
  check("addMonth clamps 31 Jan to end of Feb", addMonth(new Date("2027-01-31T00:00:00Z")).toISOString().startsWith("2027-02-28"));

  const free = await workspace("FREE", 12, 30, new Date("2026-08-01T00:00:00Z"));
  await refreshCredits(free, new Date("2026-09-15T00:00:00Z"));
  let w = await get(free);
  check("free plan: unused monthly credits expire, refill to 30", w.creditBalance === 30 && w.rolloverCredits === 0, `balance ${w.creditBalance}`);
  check("period moved to 1 Sep", w.periodStart.toISOString().startsWith("2026-09-01"));
  const expired = await db.creditEntry.findFirst({ where: { workspaceId: free, reason: "EXPIRED" } });
  check("expiry recorded in the ledger", expired?.delta === -12);
  await refreshCredits(free, new Date("2026-09-20T00:00:00Z"));
  check("refresh within the period is a no-op", (await get(free)).creditBalance === 30);

  const pro = await workspace("PRO", 520, 500, new Date("2026-08-01T00:00:00Z"));
  await refreshCredits(pro, new Date("2026-09-15T00:00:00Z"));
  w = await get(pro);
  check("paid plan: unused monthly credits roll over", w.creditBalance === 1020 && w.rolloverCredits === 500, `${w.creditBalance}/${w.rolloverCredits}`);
  check("rollover expires a period later", w.rolloverExpiresAt?.toISOString().startsWith("2026-10-01") ?? false);
  await charge(pro, 100, "GENERATION", undefined, { category: "build" });
  w = await get(pro);
  check("rollover credits are spent first", w.creditBalance === 920 && w.rolloverCredits === 400, `${w.creditBalance}/${w.rolloverCredits}`);
  await refreshCredits(pro, new Date("2026-10-02T00:00:00Z"));
  w = await get(pro);
  check("leftover rollover expires, new rollover set", w.creditBalance === 1020 && w.rolloverCredits === 500, `${w.creditBalance}/${w.rolloverCredits}`);
  const spent = await spentThisMonth(pro);
  check("expired credits don't count as spent", spent <= 100, String(spent));

  const catchUp = await workspace("FREE", 0, 30, new Date("2026-01-01T00:00:00Z"));
  await refreshCredits(catchUp, new Date("2026-06-10T00:00:00Z"));
  w = await get(catchUp);
  check("missed periods catch up in one call", w.creditBalance === 30 && w.periodStart.toISOString().startsWith("2026-06-01"));

  // ── Nudges and out of credits ──
  const now = new Date();
  check("nudge: about an hour", expiryNudge(5, new Date(now.getTime() + 30 * 60_000), now) === "5 credits expire in about an hour");
  check("nudge: today", expiryNudge(1, new Date(now.getTime() + 5 * 3600_000), now) === "1 credit expire today");
  check("no nudge two days out", expiryNudge(5, new Date(now.getTime() + 2 * DAY), now) === null);

  const empty = await workspace("FREE", 3, 30, now);
  await charge(empty, 5, "GENERATION", undefined, { category: "build" });
  w = await get(empty);
  check("running out records when", w.creditBalance === 0 && !!w.outOfCreditsAt);
  let s = await creditSummary(empty);
  check("pause date 7 days after running out", !!s.pausesAt && !s.paused);
  await db.workspace.update({ where: { id: empty }, data: { outOfCreditsAt: new Date(Date.now() - 8 * DAY) } });
  s = await creditSummary(empty);
  check("past the grace period: paused", s.paused);
  await grant(empty, 50, "TOPUP");
  w = await get(empty);
  check("adding credits clears it", w.outOfCreditsAt === null && w.creditBalance === 50);

  process.env.FORGE_FREE_BUILD_HOUR = new Date(Date.now() - 10 * 60_000).toISOString();
  check("free build hour active", !!freeBuildHour());
  await charge(empty, 7, "GENERATION", undefined, { category: "build" });
  check("builds cost nothing during it", (await get(empty)).creditBalance === 50);
  const freeRow = await db.creditEntry.findFirst({ where: { workspaceId: empty, category: "build_free" } });
  check("…but still show in usage", !!freeRow);
  await charge(empty, 4, "GENERATION", undefined, { category: "media" });
  check("other usage is still charged", (await get(empty)).creditBalance === 46);
  process.env.FORGE_FREE_BUILD_HOUR = new Date(Date.now() - 2 * 3600_000).toISOString();
  check("free build hour over after an hour", freeBuildHour() === null);
  delete process.env.FORGE_FREE_BUILD_HOUR;

  // ── Abandoned projects ──
  const ws = await workspace("FREE", 30, 30, now);
  const owner = await db.user.findFirstOrThrow({ where: { email: "dev@localhost" } }).catch(() => db.user.findFirstOrThrow());
  await db.membership.create({ data: { userId: owner.id, workspaceId: ws, role: "OWNER" } });
  const mk = (name: string) => db.project.create({ data: { workspaceId: ws, name, slug: name.toLowerCase(), subdomain: `t-${Math.random().toString(36).slice(2, 10)}`, createdById: owner.id } });
  const a = await mk("Abandoned");
  const b = await mk("Kept");
  const c = await mk("Protected");
  const later = new Date(Date.now() + (ABANDONED_DAYS + 1) * DAY);
  let r = await sweepAbandoned(later, ws);
  check("idle projects get a notice", [a.id, b.id, c.id].every((id) => r.noticed.includes(id)), JSON.stringify(r));
  const note = await db.notification.findFirst({ where: { projectId: a.id, kind: "abandoned" } });
  check("owner notified with Keep it link", !!note && note.href === `/projects/${a.id}?cleanup=1`);
  r = await sweepAbandoned(new Date(later.getTime() + DAY), ws);
  check("no repeat notice, nothing deleted yet", r.noticed.length === 0 && r.removed.length === 0);
  await answerCleanup(c.id, "protect");
  await answerCleanup(b.id, "keep");
  const kept = await db.project.findUniqueOrThrow({ where: { id: b.id } });
  check("Keep it clears the notice", kept.abandonedNoticeAt === null && !!kept.keptAt);
  r = await sweepAbandoned(new Date(later.getTime() + (GRACE_DAYS + 1) * DAY), ws);
  check("after the grace period it moves to Recently deleted", r.removed.includes(a.id) && !!(await db.project.findUniqueOrThrow({ where: { id: a.id } })).deletedAt);
  check("protected project left alone", !r.removed.includes(c.id) && !r.noticed.includes(c.id));
  check("kept project starts over with a new notice", r.noticed.includes(b.id) && !r.removed.includes(b.id));

  // ── Archives ──
  const zip = new JSZip();
  zip.file("my-app/package.json", '{"name":"x"}');
  zip.file("my-app/src/App.tsx", "export default function App() { return null }");
  zip.file("my-app/node_modules/react/index.js", "x");
  zip.file("my-app/.env", "SECRET=1");
  zip.file("my-app/public/logo.png", Buffer.from([137, 80, 78, 71]));
  const entries = await openArchive(await zip.generateAsync({ type: "nodebuffer" }));
  const paths = entries.map((e) => e.path);
  check("archive: wrapper folder dropped", paths.includes("src/App.tsx") && paths.includes("package.json"), paths.join(","));
  check("archive: node_modules and .env skipped", !paths.some((p) => p.includes("node_modules") || p.endsWith(".env")));
  check("archive: listing", listing(entries).startsWith("3 files"));
  check("archive: read a text file", (await readEntry(entries, "src/App.tsx")).includes("App"));
  let refused = false;
  try {
    await readEntry(entries, "public/logo.png");
  } catch {
    refused = true;
  }
  check("archive: binary files aren't read as text", refused);
  const ex = await extractAll(entries, "imported/");
  check("archive: extract under a folder", ex.files.every((f) => f.path.startsWith("imported/")) && ex.files.length === 3);
  let bad = false;
  try {
    await openArchive(Buffer.from("not a zip"));
  } catch {
    bad = true;
  }
  check("archive: non-zip refused", bad);

  // ── HTTP ──
  if (token) {
    const created = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Lifecycle test", force: true }),
    });
    pid = ((await created.json()) as { project: { id: string } }).project.id;

    const t1 = await fetch(`${BASE}/templates/landing-page`, { headers: { cookie }, redirect: "manual" });
    check("replaced template redirects", t1.status === 307 && (t1.headers.get("location") ?? "").includes("/templates/saas-landing?replaced=landing-page"));
    const t2 = await fetch(`${BASE}/templates/saas-landing?replaced=landing-page`, { headers: { cookie } });
    check("…with a notice", (await t2.text()).includes("template was replaced by"));
    const t3 = await fetch(`${BASE}/templates/blog`, { headers: { cookie } });
    check("removed template explains itself", (await t3.text()).includes("template was removed"));

    const cl = await fetch(`${BASE}/api/projects/${pid}/cleanup`, { headers: { cookie } });
    check("clean-up state for an active project", cl.ok && (await cl.json()).deletesAt === null);
    const prot = await fetch(`${BASE}/api/projects/${pid}/cleanup`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"choice":"protect"}' });
    check("Protect it via the API", prot.ok && (await db.project.findUniqueOrThrow({ where: { id: pid } })).cleanupProtected);

    const terms = await fetch(`${BASE}/api/workspace/billing`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"action":"autoTopup","on":true,"amount":100}' });
    const tb = await terms.json();
    const accepted = !!(await db.project.findUniqueOrThrow({ where: { id: pid }, select: { workspace: { select: { meteredTermsAt: true } } } })).workspace.meteredTermsAt;
    check(
      "auto top-up asks for usage terms first (unless accepted before)",
      accepted ? terms.status === 200 : terms.status === 409 && tb.needsTerms === true,
      `${terms.status}, accepted before: ${accepted}`,
    );
    // Never leave auto top-up switched on by the test.
    await fetch(`${BASE}/api/workspace/billing`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"action":"autoTopup","on":false}' });
    const billing = await (await fetch(`${BASE}/api/workspace/billing`, { headers: { cookie } })).json();
    check("billing shows refill date and rollover", !!billing.nextRefill && "rollover" in billing);

    const projWs = await db.project.findUniqueOrThrow({ where: { id: pid }, select: { workspace: { select: { creditBalance: true } } } });
    if (projWs.workspace.creditBalance <= 0) {
      const v = await fetch(`${BASE}/api/projects/${pid}/voice`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"action":"start"}' });
      check("voice needs credits", v.status === 402, String(v.status));
    }

    const dash = await (await fetch(`${BASE}/dashboard`, { headers: { cookie } })).text();
    check("dashboard: Where you left off / Recent projects", dash.includes("Where you left off") || dash.includes("Recent projects"));

    // Webhooks
    const ca = await fetch(`${BASE}/api/automations`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action: "create", projectId: pid, name: "Hook test", prompt: "Say hi", schedule: "0 9 * * 1", timezone: "UTC" }),
    });
    const cab = await ca.json();
    autoId = cab.automation?.id ?? cab.id ?? (await db.automation.findFirst({ where: { projectId: pid } }))?.id ?? "";
    check("automation created", !!autoId, JSON.stringify(cab).slice(0, 120));
    const on = await (await fetch(`${BASE}/api/automations`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "webhook", id: autoId, on: true }) })).json();
    const url: string = on.webhookUrl ?? "";
    check("webhook URL issued", /\/api\/hooks\/automations\/[\w-]{32}$/.test(url), url.replace(/[\w-]{32}$/, "<token>"));
    const listed = await (await fetch(`${BASE}/api/automations`, { headers: { cookie } })).json();
    const row = listed.automations.find((x: { id: string }) => x.id === autoId);
    check("list shows the URL, never the raw token field", row?.webhookUrl === url && !("webhookToken" in row));
    check("unknown token is 404", (await fetch(`${BASE}/api/hooks/automations/${"x".repeat(32)}`, { method: "POST" })).status === 404);
    check("oversized body is 413", (await fetch(url, { method: "POST", body: "x".repeat(10_001) })).status === 413);
    const fire = await fetch(url, { method: "POST", body: '{"event":"test"}' });
    check("webhook fires (202, or 402 when the workspace has no credits)", fire.status === 202 || fire.status === 402, String(fire.status));
    if (fire.status === 202) {
      const { buildId } = await fire.json();
      const again = await fetch(url, { method: "POST", body: "{}" });
      check("one run a minute", again.status === 429);
      const build = await db.build.findUnique({ where: { id: buildId }, select: { messageId: true } });
      const user = await db.message.findFirst({ where: { projectId: pid, role: "USER" }, orderBy: { createdAt: "desc" } });
      check("payload reaches the agent as data", !!user?.content.includes('{"event":"test"}') && user.content.includes("not instructions"), user?.content.slice(0, 80));
      // Don't spend credits on a real run: stop it and let it settle.
      await fetch(`${BASE}/api/builds/${buildId}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"action":"stop"}' });
      for (let i = 0; i < 60; i++) {
        const st = await db.build.findUnique({ where: { id: buildId }, select: { status: true } });
        if (!st || !["QUEUED", "RUNNING"].includes(st.status)) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      check("webhook run stopped", !!build);
    } else {
      check("credit pause stops further runs", (await fetch(url, { method: "POST", body: "{}" })).status === 409);
    }
    await fetch(`${BASE}/api/automations`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "webhook", id: autoId, on: false }) });
    check("turning it off revokes the URL", (await fetch(url, { method: "POST", body: "{}" })).status === 404);
  }
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (autoId) await db.automation.delete({ where: { id: autoId } }).catch(() => undefined);
  if (pid) {
    await db.notification.deleteMany({ where: { projectId: pid } }).catch(() => undefined);
    // Stop any webhook run before deleting.
    await db.build.updateMany({ where: { projectId: pid, status: { in: ["QUEUED"] } }, data: { status: "CANCELLED" } }).catch(() => undefined);
    const del = await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
    check("test project deleted", del.ok, String(del.status));
  }
  for (const id of wsIds) {
    await db.notification.deleteMany({ where: { projectId: { in: (await db.project.findMany({ where: { workspaceId: id }, select: { id: true } })).map((p) => p.id) } } }).catch(() => undefined);
    await db.workspace.delete({ where: { id } }).catch((e) => check("cleanup workspace", false, String(e)));
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
