/**
 * Google Maps in the publish checklist (and Forge's key only for apps without
 * their own), the admin action center (access requests, failing jobs, security
 * by project, acknowledge), app tiering (YAML rules, admin labels), template
 * listings, and onboarding (role → tasks → starter apps).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle28.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
const outsider = `authjs.session-token=${users["outsider@localhost"]}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fetchRetry: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    await sleep(500);
    return fetch(input, init);
  }
};
const call = async (p: string, body?: unknown, c = cookie, method?: string) => {
  const r = await fetchRetry(`${BASE}${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie: c, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const made: string[] = [];
const newProject = async (name: string) => {
  const id = ((await call("/api/projects", { name, force: true })).json.project as { id: string }).id;
  made.push(id);
  return id;
};
const commitFile = async (pid: string, rel: string, content: string) => {
  const { writeFiles, commit } = await import("../src/lib/repo");
  await writeFiles(pid, [{ path: rel, content }]);
  await commit(pid, `add ${rel}`);
};
let savedYaml: string | null = null;

try {
  // ── Google Maps
  const maps = await newProject("C28 store locator");
  await commitFile(maps, "src/components/Map.tsx", `import { APIProvider, Map } from "@vis.gl/react-google-maps";\nexport default () => <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}><Map /></APIProvider>;\n`);
  const item = async () => ((await call(`/api/projects/${maps}/setup-review`)).json.items as { id: string; status: string; detail: string }[]).find((i) => i.id === "maps");
  const m1 = await item();
  check("an app using Google Maps gets a Maps step in the publish checklist", m1?.status === "todo", JSON.stringify(m1));
  const plain = await newProject("C28 no maps");
  check("apps without maps don't", !((await call(`/api/projects/${plain}/setup-review`)).json.items as { id: string }[]).some((i) => i.id === "maps"));
  await call(`/api/projects/${maps}/env`, { set: [{ name: "VITE_GOOGLE_MAPS_API_KEY", value: "AIzaTestKey123456" }] }, cookie, "PUT");
  const m2 = await item();
  check("setting the app's own key completes it", m2?.status === "ok" && /own/.test(m2.detail));
  process.env.FORGE_GOOGLE_MAPS_KEY = "AIzaForgeKey987654321";
  const gm = await import("../src/lib/google-maps");
  check("Forge's key isn't injected over the app's own", (await gm.mapsBuildEnv(maps)) === "");
  await call(`/api/projects/${maps}/env`, { remove: ["VITE_GOOGLE_MAPS_API_KEY"] }, cookie, "PUT");
  check("an app without its own key builds with Forge's", (await gm.mapsBuildEnv(maps)) === "VITE_GOOGLE_MAPS_API_KEY=AIzaForgeKey987654321 ");
  check("apps that don't use maps never get it", (await gm.mapsBuildEnv(plain)) === "");

  // ── Action center
  const restricted = await newProject("C28 restricted");
  await db.project.update({ where: { id: restricted }, data: { restricted: true } });
  const req = await call(`/api/projects/${restricted}/access-requests`, { kind: "view", message: "Need to check numbers" }, outsider);
  check("someone outside can ask for access", req.status === 200 || req.status === 201, String(req.status));
  let ac = (await call("/api/workspace/action-center")).json as { approvals: { id: string; projectId: string; type: string }[]; anomalies: { id: string; projectId: string }[]; security: { projectId: string; high: number }[] };
  const ask = ac.approvals.find((a) => a.projectId === restricted && a.type === "access");
  check("the request shows in the action center", !!ask);
  await call(`/api/projects/${restricted}/access-requests`, { requestId: ask!.id, decision: "approve" }, cookie, "PATCH");
  ac = (await call("/api/workspace/action-center")).json as typeof ac;
  check("approving it there clears it", !ac.approvals.some((a) => a.id === ask!.id));
  await db.securityFinding.create({ data: { projectId: plain, sha: "x", rule: "test", severity: "HIGH", file: "src/x.ts", detail: "test finding" } });
  await call(`/api/projects/${plain}/cloud`, { action: "enable" });
  const f = path.join(ROOT, plain, "functions", "boom.ts");
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, `export default () => { throw new Error("nope"); };`);
  await call(`/api/projects/${plain}/cloud/admin`, { action: "deployFunctions" });
  const job = (await call(`/api/projects/${plain}/cloud/admin`, { action: "createJob", name: "Nightly", fn: "boom", schedule: "0 3 * * *" })).json as { id: string };
  await call(`/api/projects/${plain}/cloud/admin`, { action: "runJob", jobId: job.id });
  ac = (await call("/api/workspace/action-center")).json as typeof ac;
  const anomaly = ac.anomalies.find((a) => a.projectId === plain);
  check("a failing scheduled job is an anomaly", !!anomaly);
  check("open findings show per project", ac.security.some((s) => s.projectId === plain && s.high === 1));
  await call("/api/workspace/action-center", { action: "acknowledge", id: anomaly!.id });
  check("an acknowledged anomaly goes away", !((await call("/api/workspace/action-center")).json.anomalies as { id: string }[]).some((a) => a.id === anomaly!.id));

  // ── Tiering
  savedYaml = (await db.workspace.findFirst({ where: { slug: { not: "" }, memberships: { some: { user: { email: "dev@localhost" } } } }, select: { tieringYaml: true } }))?.tieringYaml ?? null;
  check("unknown rule fields are refused", (await call("/api/workspace/tiering", { action: "rules", yaml: "tiers:\n  - name: A\n    rules:\n      - colour: red\n" })).status === 400);
  check("broken YAML is refused", (await call("/api/workspace/tiering", { action: "rules", yaml: "tiers: [" })).status === 400);
  const yaml = "tiers:\n  - name: Critical\n    rules:\n      - labels: [customer-facing]\n  - name: Backend apps\n    rules:\n      - cloud: true\n  - name: Sandbox\n    default: true\n";
  let t = (await call("/api/workspace/tiering", { action: "rules", yaml })).json as { apps: { id: string; tier: string }[] };
  const tierOf = (id: string) => t.apps.find((a) => a.id === id)?.tier;
  check("rules place apps in tiers", tierOf(plain) === "Backend apps" && tierOf(maps) === "Sandbox", `${tierOf(plain)} / ${tierOf(maps)}`);
  await call("/api/workspace/tiering", { action: "labels", projectId: maps, labels: ["Customer-Facing", "bad label!"] });
  t = (await call("/api/workspace/tiering")).json as typeof t;
  check("admin labels move an app up a tier (and are cleaned)", tierOf(maps) === "Critical" && JSON.stringify((t.apps.find((a) => a.id === maps) as unknown as { labels: string[] }).labels) === '["customer-facing"]');

  // ── Template listing
  check("a listing needs a tagline", (await call(`/api/projects/${plain}/listing`, { category: "Data" }, cookie, "PUT")).status === 400);
  const put = await call(`/api/projects/${plain}/listing`, { tagline: "Track anything", about: "A tracker", category: "Data", publisherType: "company", icon: "📊", hidePreview: true }, cookie, "PUT");
  check("a listing is saved and puts the project in the gallery", put.status === 200 && (await db.project.findUnique({ where: { id: plain } }))?.isTemplate === true);
  const list = (await call("/api/projects?view=templates")).json as { projects?: { id: string; listing: { tagline: string; publisherType: string } | null }[] } | { id: string; listing: unknown }[];
  const cards = Array.isArray(list) ? list : (list.projects ?? []);
  const card = (cards as { id: string; listing: { tagline: string; publisherType: string } | null }[]).find((c) => c.id === plain);
  check("the gallery shows the listing", card?.listing?.tagline === "Track anything" && card.listing.publisherType === "company", JSON.stringify(card?.listing));
  await call(`/api/projects/${plain}/listing`, undefined, cookie, "DELETE");
  check("removing the listing takes it out of the gallery", (await db.project.findUnique({ where: { id: plain } }))?.isTemplate === false);

  // ── Onboarding
  check("onboarding needs a known role", (await call("/api/account/onboarding", { role: "Wizard", tasks: [] }, outsider)).status === 400);
  const ob = await call("/api/account/onboarding", { role: "Sales", tasks: ["Managing deals", "Preparing quotes", "Not a task"] }, outsider);
  check("picking a role and tasks previews one starter app per task", (ob.json.starters as { name: string }[]).map((s) => s.name).join(",") === "Deal pipeline,Quote builder");
  check("and the answers are kept", ((await call("/api/account/onboarding", undefined, outsider)).json.answers as { role: string }).role === "Sales");
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  const ws = await db.workspace.findFirst({ where: { memberships: { some: { user: { email: "dev@localhost" } } } }, select: { id: true } });
  if (ws) await db.workspace.update({ where: { id: ws.id }, data: { tieringYaml: savedYaml } });
  await fs.rm(path.join(ROOT, "_forge", "onboarding"), { recursive: true, force: true }).catch(() => undefined);
  for (const id of made) await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
