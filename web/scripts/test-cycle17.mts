/**
 * Free build hour from Settings → Platform (and that builds cost nothing in
 * it), the personal dashboard line, switching the work to another project
 * (one live turn) with access checks, and the AI deep scan (one live review
 * of a planted bug). Restores platform.json afterwards.
 *   npx tsx scripts/test-cycle17.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { commit, writeFiles } from "../src/lib/repo";
import { charge } from "../src/lib/credits";
import { dashboardNudge } from "../src/lib/nudges";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
const PLATFORM = path.join(process.env.PROJECTS_ROOT ?? "", "_forge", "platform.json");
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (url: string, method: string, body?: unknown, c = cookie) => {
  const r = await fetch(`${BASE}${url}`, { method, headers: { cookie: c, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const waitBuild = async (id: string, secs = 240) => {
  for (let i = 0; i < secs / 2; i++) {
    const b = await db.build.findUnique({ where: { id } });
    if (b && !["QUEUED", "RUNNING"].includes(b.status)) return b.status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "TIMEOUT";
};
const platformBackup = await fs.readFile(PLATFORM, "utf8").catch(() => null);
const projects: string[] = [];
const userId = (await db.session.findUniqueOrThrow({ where: { sessionToken: token } })).userId;

try {
  // ── Free build hour, set from Settings → Platform ──
  check("non-admins can't change platform settings", (await call("/api/admin/platform", "POST", { freeBuildHourStart: new Date().toISOString() }, `authjs.session-token=${users["member@localhost"]}`)).status === 403);
  const on = await call("/api/admin/platform", "POST", { freeBuildHourStart: new Date(Date.now() - 60_000).toISOString() });
  check("starting it now makes it active for an hour", !!on.json.freeBuildHourActiveUntil && new Date(String(on.json.freeBuildHourActiveUntil)).getTime() > Date.now() + 58 * 60_000);
  const ws = (await db.membership.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "asc" } })).workspaceId;
  const before = (await db.workspace.findUniqueOrThrow({ where: { id: ws } })).creditBalance;
  await charge(ws, 3, "GENERATION", undefined, { category: "build", userId });
  check("builds cost nothing during it", (await db.workspace.findUniqueOrThrow({ where: { id: ws } })).creditBalance === before);
  const html = await (await fetch(`${BASE}/dashboard`, { headers: { cookie } })).text();
  check("everyone sees the banner", /Free build hour/i.test(html));
  const off = await call("/api/admin/platform", "POST", { freeBuildHourStart: null });
  check("turning it off ends it", off.json.freeBuildHourActiveUntil === null && off.json.freeBuildHourStart === null);
  check("bad times are refused", (await call("/api/admin/platform", "POST", { freeBuildHourStart: "not a date" })).status === 400);

  // ── Personal dashboard line ──
  const mk = async (name: string) => {
    const id = ((await call("/api/projects", "POST", { name, force: true })).json.project as { id: string }).id;
    projects.push(id);
    return id;
  };
  const target = await mk("Cycle 17 admin app");
  const nudge = await dashboardNudge(userId, ws, [{ id: target, name: "Cycle 17 admin app", unpublishedChanges: true, updatedAt: new Date().toISOString() } as never]);
  check("a personal line picks something useful", !!nudge && typeof nudge.text === "string", JSON.stringify(nudge));
  const dash = await (await fetch(`${BASE}/dashboard`, { headers: { cookie } })).text();
  check("the dashboard shows it under the greeting", /data-testid="dashboard-nudge"/.test(dash));

  // ── Deep scan with a planted bug ──
  const scanPid = await mk("Cycle 17 deep scan");
  await writeFiles(scanPid, [
    {
      path: "src/lib/orders.ts",
      content: [
        "// Loads orders for the signed-in user.",
        "export async function loadOrders() {",
        "  const userId = new URLSearchParams(location.search).get('user');",
        "  const res = await fetch(`/cloud/v1/app/db/orders?user_id=${userId}`, { headers: { 'x-service-key': 'svc_live_9f8a7b6c5d4e3f2a1b0c' } });",
        "  return res.json();",
        "}",
        "export function isAdmin() {",
        "  return localStorage.getItem('role') === 'admin';",
        "}",
        "",
      ].join("\n"),
    },
  ]);
  await db.project.update({ where: { id: scanPid }, data: { headSha: await commit(scanPid, "Orders") } });
  const t0 = Date.now();
  const deep = await call(`/api/projects/${scanPid}/security`, "POST", { action: "deep-scan" });
  const ds = deep.json.deepScan as { count: number; credits: number } | undefined;
  check("the deep scan finds the planted problems", deep.status === 200 && (ds?.count ?? 0) >= 1, `${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify(deep.json).slice(0, 200)}`);
  const sec = (await call(`/api/projects/${scanPid}/security`, "GET")).json as { findings: { rule: string; category: string; title: string; file: string; severity: string }[]; deepScan: { summary: string } | null };
  const deepRows = sec.findings.filter((f) => f.rule.startsWith("deep:"));
  check("its findings join the security center", deepRows.length >= 1 && deepRows.every((f) => f.category === "AI deep scan" && f.title && f.file.includes("orders")) && !!sec.deepScan?.summary, deepRows.map((f) => `${f.severity} ${f.title}`).join(" | ").slice(0, 300));
  check("it cost credits", (ds?.credits ?? 0) > 0);
  await call(`/api/projects/${scanPid}/security`, "POST", { action: "scan" });
  const after = (await call(`/api/projects/${scanPid}/security`, "GET")).json as { findings: { rule: string }[] };
  check("a regular scan keeps the deep findings", after.findings.filter((f) => f.rule.startsWith("deep:")).length === deepRows.length);

  // ── Switching the work to another project ──
  const here = await mk("Cycle 17 main app");
  const sent = (await call(`/api/projects/${here}/messages`, "POST", {
    content: "Switch to my project \"Cycle 17 admin app\" and have it add a heading that says Admin. Don't change this project.",
    mode: "build",
  })).json as { buildId: string };
  const status = await waitBuild(sent.buildId);
  const reply = await db.message.findFirst({ where: { projectId: here, role: "ASSISTANT" }, orderBy: { createdAt: "desc" } });
  const moved = ((reply?.steps as string[]) ?? []).find((s) => s.startsWith("moved:"));
  check("the agent moves the work and shows a card", status === "SUCCEEDED" && moved === `moved:${target}:Cycle 17 admin app`, `${status} ${moved ?? (reply?.content ?? "").slice(0, 160)}`);
  const queued = await db.message.findFirst({ where: { projectId: target, role: "USER" }, orderBy: { createdAt: "desc" } });
  check("the other project got the instruction", !!queued && /admin/i.test(queued.content), queued?.content.slice(0, 120));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (platformBackup === null) await fs.rm(PLATFORM, { force: true });
  else await fs.writeFile(PLATFORM, platformBackup);
  for (const id of projects) {
    await db.build.updateMany({ where: { projectId: id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED" } });
    await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
