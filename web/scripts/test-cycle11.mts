/**
 * Publish entitlements, build job log, links to drafts that are no longer
 * open, contract status and "Contact sales", and the access review.
 * Throwaway projects; the dev workspace's sales request is undone afterwards.
 *   npx tsx scripts/test-cycle11.mts <devToken>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { entitlementsFor } from "../src/lib/entitlements";
import { createDraft } from "../src/lib/drafts";
import { PROJECTS_ROOT } from "../src/lib/paths";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const SALES = path.join(PROJECTS_ROOT, "_forge", "sales-requests.jsonl");
let pid = "";
let wsId = "";
let salesBefore: string | null = null;

try {
  pid = ((await (await fetch(`${BASE}/api/projects`, json("POST", { name: "Cycle 11 test", force: true }))).json()) as { project: { id: string } }).project.id;
  const proj = await db.project.findUniqueOrThrow({ where: { id: pid }, select: { workspaceId: true, createdById: true, workspace: { select: { plan: true } } } });
  wsId = proj.workspaceId;

  // ── Entitlements ──
  check("free plan: badge stays, no custom domain", !entitlementsFor("FREE").hideBadge && !entitlementsFor("FREE").customDomain);
  check("paid plans: both", entitlementsFor("PRO").hideBadge && entitlementsFor("BUSINESS").customDomain);
  if (proj.workspace.plan === "FREE") {
    const badge = await fetch(`${BASE}/api/projects/${pid}/publish`, json("PATCH", { showBadge: false }));
    check("free plan can't hide the badge", badge.status === 402 && (await badge.json()).upgrade === true);
    const dom = await fetch(`${BASE}/api/projects/${pid}`, json("PATCH", { customDomain: "app.example.com" }));
    check("free plan can't add a custom domain", dom.status === 402);
    check("showing the badge is always fine", (await fetch(`${BASE}/api/projects/${pid}/publish`, json("PATCH", { showBadge: true }))).ok);
    const info = await (await fetch(`${BASE}/api/projects/${pid}/publish`, { headers: { cookie } })).json();
    check("publish info carries entitlements", info.entitlements?.plan === "FREE" && info.entitlements.hideBadge === false);
  } else console.log("SKIP workspace isn't on the free plan");

  // ── Build log ──
  await fetch(`${BASE}/api/projects/${pid}/queue`, json("POST", { action: "pause" }));
  const sent = await (await fetch(`${BASE}/api/projects/${pid}/messages`, json("POST", { content: "Add a footer", mode: "build" }))).json();
  const events = [
    { type: "build_started", payload: {} },
    { type: "text", payload: { delta: "Adding " } },
    { type: "text", payload: { delta: "a footer." } },
    { type: "tool", payload: { step: `call:${JSON.stringify({ t: "write_file", i: "{}", o: "ok" })}` } },
    { type: "file", payload: { op: "write", path: "src/Footer.tsx" } },
    { type: "usage", payload: { inputTokens: 1200, outputTokens: 300 } },
  ];
  await db.buildEvent.createMany({ data: events.map((e, i) => ({ buildId: sent.buildId, seq: i + 1, type: e.type, payload: e.payload })) });
  const log = await (await fetch(`${BASE}/api/builds/${sent.buildId}/log`, { headers: { cookie } })).json();
  const texts = (log.lines ?? []).map((l: { text: string }) => l.text);
  check("log merges narration into one line", texts.includes("Adding a footer."), texts.join(" | "));
  check("log names tool calls and files", texts.includes("tool write_file") && texts.includes("write src/Footer.tsx") && texts.includes("tokens in 1200, out 300"));
  check("log needs access", (await fetch(`${BASE}/api/builds/${sent.buildId}/log`)).status === 401);
  await db.build.updateMany({ where: { projectId: pid, status: "QUEUED" }, data: { status: "CANCELLED" } });

  // ── Links to drafts ──
  const d = await createDraft(pid, proj.createdById!, "Old draft");
  await db.draft.update({ where: { id: d.id }, data: { status: "MERGED", mergedAt: new Date() } });
  const merged = await (await fetch(`${BASE}/projects/${pid}?draft=${d.id}`, { headers: { cookie } })).text();
  check("accepted draft link explains itself", merged.includes("was already accepted"));
  const gone = await (await fetch(`${BASE}/projects/${pid}?draft=nope`, { headers: { cookie } })).text();
  check("missing draft link explains itself", gone.includes("already accepted or deleted"));

  // ── Contract status and Contact sales ──
  salesBefore = await fs.readFile(SALES, "utf8").catch(() => null);
  const billing = await (await fetch(`${BASE}/api/workspace/billing`, { headers: { cookie } })).json();
  check("billing shows the current period", !!billing.period?.start && !!billing.period?.end && new Date(billing.period.end) > new Date(billing.period.start));
  check("company is required", (await fetch(`${BASE}/api/workspace/billing`, json("POST", { action: "contactSales" }))).status === 400);
  const sales = await fetch(`${BASE}/api/workspace/billing`, json("POST", { action: "contactSales", company: "Acme Test Ltd", seats: 25, message: "SSO please" }));
  const after = await (await fetch(`${BASE}/api/workspace/billing`, { headers: { cookie } })).json();
  const saved = (await fs.readFile(SALES, "utf8")).trim().split("\n").at(-1) ?? "";
  check("sales request recorded", sales.ok && !!after.salesRequestedAt && saved.includes("Acme Test Ltd") && saved.includes('"seats":25'));

  // ── Access review ──
  const review = await (await fetch(`${BASE}/api/projects/access-review?ids=${pid}`, { headers: { cookie } })).json();
  const row = review.projects?.[0];
  check("access review", row?.id === pid && row.visibility.startsWith("Everyone") && row.inviteLink === "Off" && row.site === "Not published", JSON.stringify(row).slice(0, 160));
  check("other workspaces' projects aren't reviewable", (await (await fetch(`${BASE}/api/projects/access-review?ids=not-a-project`, { headers: { cookie } })).json()).projects.length === 0);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  if (wsId) await db.workspace.update({ where: { id: wsId }, data: { salesRequestedAt: null } });
  if (salesBefore === null) await fs.rm(SALES, { force: true });
  else await fs.writeFile(SALES, salesBefore);
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
