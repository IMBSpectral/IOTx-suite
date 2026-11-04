/**
 * Live checks of features that were built but never seen running:
 * clarifying questions / task list in a Plan turn (free allowance), an
 * automation pausing after 3 failed runs, the publish-failed result for a
 * project that doesn't build, and publish approvals (member asks, admin
 * publishes). Restores the workspace's approval setting afterwards.
 *   npx tsx scripts/test-live-verify.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import { db } from "../src/lib/db";
import { commit, writeFiles } from "../src/lib/repo";
import { tickAutomations, MAX_FAILURES } from "../src/lib/automations";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookieOf = (t: string) => `authjs.session-token=${t}`;
const cookie = cookieOf(token);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown, c = cookie) => ({ method, headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
const waitBuild = async (id: string, secs = 180) => {
  for (let i = 0; i < secs / 2; i++) {
    const b = await db.build.findUnique({ where: { id }, select: { status: true } });
    if (b && !["QUEUED", "RUNNING"].includes(b.status)) return b.status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "TIMEOUT";
};
/** Read a publish SSE stream to the end; returns the last event. */
const publish = async (pid: string, c: string) => {
  const res = await fetch(`${BASE}/api/projects/${pid}/publish`, json("POST", { action: "publish" }, c));
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("event-stream")) return { status: res.status, ...(await res.json()) };
  const text = await res.text();
  const events = text.split("\n\n").filter((p) => p.startsWith("data: ")).map((p) => JSON.parse(p.slice(6)));
  return events.at(-1) ?? {};
};

const projects: string[] = [];
let wsId = "";
let approvalBefore: boolean | null = null;

try {
  // ── A.3 / A.9: a vague request in Plan mode ──
  const plan = ((await (await fetch(`${BASE}/api/projects`, json("POST", { name: "Live verify plan", force: true }))).json()) as { project: { id: string } }).project.id;
  projects.push(plan);
  const sent = await (await fetch(`${BASE}/api/projects/${plan}/messages`, json("POST", { content: "I want an app for my business. Before planning, ask me what you need to know.", mode: "plan" }))).json();
  const status = await waitBuild(sent.buildId);
  const msg = await db.message.findUnique({ where: { id: sent.messageId }, select: { steps: true, content: true } });
  const steps = (msg?.steps as string[] | null) ?? [];
  const questions = steps.find((s) => s.startsWith("questions:"));
  check("clarifying questions card in a live Plan turn", status === "SUCCEEDED" && !!questions, questions ? questions.slice(10, 170) : `${status}: ${msg?.content.slice(0, 120)}`);

  // ── B.7: automation pauses after repeated failures ──
  wsId = (await db.project.findUniqueOrThrow({ where: { id: plan } })).workspaceId;
  const owner = (await db.project.findUniqueOrThrow({ where: { id: plan } })).createdById!;
  const failedMsg = await db.message.create({ data: { projectId: plan, role: "ASSISTANT", content: "Build failed: test", mode: "automation" } });
  const failedBuild = await db.build.create({ data: { projectId: plan, messageId: failedMsg.id, status: "FAILED", mode: "build" } });
  const auto = await db.automation.create({
    data: { workspaceId: wsId, projectId: plan, name: "Failing automation", prompt: "x", schedule: "0 9 * * 1", nextRunAt: new Date(Date.now() + 86_400_000), createdById: owner, failures: MAX_FAILURES - 1, lastBuildId: failedBuild.id, lastResult: null },
  });
  await tickAutomations();
  const after = await db.automation.findUniqueOrThrow({ where: { id: auto.id } });
  check(`"Paused — failing" after ${MAX_FAILURES} failed runs`, after.status === "paused" && after.pausedReason === "failing" && after.failures === MAX_FAILURES);
  check("owner notified", !!(await db.notification.findFirst({ where: { projectId: plan, kind: "automation", title: { contains: "Failing automation" } } })));
  await db.automation.delete({ where: { id: auto.id } });

  // ── N.8: a project that doesn't build can't be published ──
  const broken = ((await (await fetch(`${BASE}/api/projects`, json("POST", { name: "Live verify publish", force: true }))).json()) as { project: { id: string } }).project.id;
  projects.push(broken);
  // Builds, but would crash on load: the type check warns (it doesn't block).
  await writeFiles(broken, [{ path: "src/App.tsx", content: "export default function App() {\n  return <div>{missingThing.value}</div>;\n}\n" }]);
  await db.project.update({ where: { id: broken }, data: { headSha: await commit(broken, "Undefined name") } });
  const checkRes = await fetch(`${BASE}/api/projects/${broken}/publish`, json("POST", { action: "check" }));
  const checkEvents = (await checkRes.text()).split("\n\n").filter((p) => p.startsWith("data: ")).map((p) => JSON.parse(p.slice(6)));
  const result = checkEvents.find((e) => e.type === "checks")?.result;
  const types = result?.checks?.find((c: { id: string }) => c.id === "types");
  check("type check warns about a name that would crash the app", types?.status === "warning" && /likely to break/.test(types.summary) && !result.blocking, JSON.stringify(types).slice(0, 220));

  // A real build error: the missing module is used, so it can't be dropped as an unused import.
  await writeFiles(broken, [{ path: "src/App.tsx", content: "import Nope from './does-not-exist';\nexport default function App() {\n  return <Nope />;\n}\n" }]);
  await db.project.update({ where: { id: broken }, data: { headSha: await commit(broken, "Break the build") } });
  const t0 = Date.now();
  const fail = await publish(broken, cookie);
  check("publishing a broken build is blocked with the build errors", fail.type === "blocked" || fail.type === "error", `${fail.type} in ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(fail).slice(0, 220)}`);
  check("nothing went live", !(await db.project.findUniqueOrThrow({ where: { id: broken } })).publishedSha);

  // ── N.15: publish approvals ──
  approvalBefore = (await db.workspace.findUniqueOrThrow({ where: { id: wsId } })).publishRequiresApproval;
  await db.workspace.update({ where: { id: wsId }, data: { publishRequiresApproval: true } });
  await writeFiles(broken, [{ path: "src/App.tsx", content: "export default function App() {\n  return <h1>Approved publish</h1>;\n}\n" }]);
  await db.project.update({ where: { id: broken }, data: { headSha: await commit(broken, "Fix the build") } });
  const memberToken = users["member@localhost"];
  const memberId = (await db.session.findUnique({ where: { sessionToken: memberToken }, select: { userId: true } }))?.userId;
  const isMember = memberId && (await db.membership.findFirst({ where: { userId: memberId, workspaceId: wsId } }));
  if (isMember) {
    const ask = await publish(broken, cookieOf(memberToken));
    const p1 = await db.project.findUniqueOrThrow({ where: { id: broken } });
    check("member's publish becomes a request", ask.requested === true && !!p1.publishRequestedAt && !p1.publishedSha);
    check("admins notified of the request", !!(await db.notification.findFirst({ where: { projectId: broken, kind: "publish_request" } })));
    const info = await (await fetch(`${BASE}/api/projects/${broken}/publish`, { headers: { cookie } })).json();
    check("admin sees the pending request", !!info.requestedAt && info.canApprove === true);
    const t1 = Date.now();
    const ok = await publish(broken, cookie);
    const p2 = await db.project.findUniqueOrThrow({ where: { id: broken } });
    check("admin publishes: live, request cleared", ok.type === "published" && !!p2.publishedSha && !p2.publishRequestedAt, `${ok.type} in ${Math.round((Date.now() - t1) / 1000)}s ${ok.url ?? JSON.stringify(ok).slice(0, 160)}`);
  } else console.log("SKIP member@localhost isn't in this workspace");
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (wsId && approvalBefore !== null) await db.workspace.update({ where: { id: wsId }, data: { publishRequiresApproval: approvalBefore } });
  for (const id of projects) {
    await db.build.updateMany({ where: { projectId: id, status: "QUEUED" }, data: { status: "CANCELLED" } });
    await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
