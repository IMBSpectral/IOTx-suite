/**
 * Backend coverage in the security scan, "Review project setup", the
 * sidebar's "Working now", template personas, and the agent's thinking
 * summary (one small live Ask turn at the end).
 *   npx tsx scripts/test-cycle9.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { closeDatabase, enableCloud, openDatabase, requestSecret, setPolicy } from "../src/lib/cloud";
import { backendFindings } from "../src/lib/backend-scan";
import { reviewSetup } from "../src/lib/setup-review";
import { personasOf } from "../src/lib/templates";
import { parseStep } from "../src/components/chat/types";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const projects: string[] = [];
const create = async (name: string) => {
  const id = ((await (await fetch(`${BASE}/api/projects`, json("POST", { name, force: true }))).json()) as { project: { id: string } }).project.id;
  projects.push(id);
  return id;
};

try {
  // ── Backend findings ──
  const pid = await create("Cycle 9 test");
  check("no backend, no backend findings", (await backendFindings(pid)).length === 0);
  await enableCloud(pid);
  openDatabase(pid).exec("CREATE TABLE guestbook (id INTEGER PRIMARY KEY, message TEXT); CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT);");
  await setPolicy(pid, "guestbook", { read: "public", write: "public" });
  await setPolicy(pid, "customers", { read: "public", write: "authenticated" });
  const f = await backendFindings(pid);
  check("public writes flagged", f.some((x) => x.rule === "cloud-public-write" && x.file === "cloud:guestbook" && x.severity === "HIGH"));
  check("personal data readable by anyone flagged", f.some((x) => x.rule === "cloud-public-pii" && x.file === "cloud:customers" && /email/.test(x.detail)));
  check("safe tables not flagged", !f.some((x) => x.file === "cloud:guestbook" && x.rule === "cloud-public-pii"));
  const scan = await fetch(`${BASE}/api/projects/${pid}/security`, json("POST", { action: "scan" }));
  const findings = await db.securityFinding.findMany({ where: { projectId: pid } });
  check("Security tab scan includes them", scan.ok && findings.some((x) => x.rule === "cloud-public-write"), `${findings.length} findings`);
  await setPolicy(pid, "guestbook", { read: "public", write: "authenticated" });
  check("fixing the rule clears it", !(await backendFindings(pid)).some((x) => x.rule === "cloud-public-write"));

  // ── Review project setup ──
  await requestSecret(pid, "STRIPE_KEY", "For checkout");
  closeDatabase(pid);
  const items = await reviewSetup(pid);
  const by = (id: string) => items.find((i) => i.id === id);
  check("checklist: SEO, favicon, secrets, migrations, security", ["seo", "favicon", "secrets", "migrations", "security"].every((id) => by(id)), items.map((i) => `${i.id}:${i.status}`).join(" "));
  check("waiting secret is a to-do", by("secrets")?.status === "todo" && /STRIPE_KEY/.test(by("secrets")!.detail));
  check("open high findings are a to-do", by("security")?.status === "todo");
  const api = await (await fetch(`${BASE}/api/projects/${pid}/setup-review`, { headers: { cookie } })).json();
  check("setup review API", Array.isArray(api.items) && api.items.length === items.length);

  // ── Working now ──
  const busy = await create("Background work test");
  await fetch(`${BASE}/api/projects/${busy}/queue`, json("POST", { action: "pause" }));
  await fetch(`${BASE}/api/projects/${busy}/messages`, json("POST", { content: "Add a footer", mode: "build" }));
  const dash = await (await fetch(`${BASE}/dashboard`, { headers: { cookie } })).text();
  check("sidebar shows queued background work", dash.includes("Working now") && dash.includes("Background work test") && dash.includes("1 queued"));
  await db.build.updateMany({ where: { projectId: busy, status: "QUEUED" }, data: { status: "CANCELLED" } });

  // ── Templates ──
  check("personas", personasOf("crm-lite").includes("Small businesses") && personasOf("crm-lite").includes("Teams") && personasOf("portfolio").includes("Freelancers & creatives"));

  // ── Thinking ──
  const t = parseStep(`thinking:${JSON.stringify({ ms: 4200, text: "Check App.tsx first." })}`);
  check("thinking step parses", t?.kind === "thinking" && t.ms === 4200 && t.text === "Check App.tsx first.");
  const live = await create("Thinking check");
  const r = await (await fetch(`${BASE}/api/projects/${live}/messages`, json("POST", { content: "Should this app use a router? Look at the code and answer in one sentence.", mode: "ask" }))).json();
  let status = "";
  for (let i = 0; i < 90; i++) {
    status = (await db.build.findUnique({ where: { id: r.buildId }, select: { status: true } }))?.status ?? "";
    if (!["QUEUED", "RUNNING"].includes(status)) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  const msg = await db.message.findUnique({ where: { id: r.messageId }, select: { steps: true } });
  const thinking = ((msg?.steps as string[] | null) ?? []).map(parseStep).find((s) => s?.kind === "thinking");
  check(
    "a live turn records its thinking summary",
    status === "SUCCEEDED" && !!thinking && thinking.kind === "thinking" && (thinking.text.length > 0 || thinking.ms > 0),
    thinking && thinking.kind === "thinking" ? `${Math.round(thinking.ms / 1000)}s, "${thinking.text.slice(0, 90).replace(/\n/g, " ")}"` : status,
  );
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of projects) {
    closeDatabase(id);
    await db.build.updateMany({ where: { projectId: id, status: "QUEUED" }, data: { status: "CANCELLED" } });
    await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
