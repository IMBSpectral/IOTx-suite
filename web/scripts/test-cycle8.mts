/**
 * Several chats per project, tool-call records, @-mentioning other projects,
 * and traffic anomaly detection. The test project's queue is paused, so no
 * agent turn runs.
 *   npx tsx scripts/test-cycle8.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { parseStep } from "../src/components/chat/types";
import { mentionedProjects } from "../src/components/chat/project-names";
import { trafficAnomalies } from "../src/lib/monitoring";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

let pid = "";
try {
  const created = await fetch(`${BASE}/api/projects`, json("POST", { name: "Cycle 8 test", force: true }));
  pid = ((await created.json()) as { project: { id: string } }).project.id;
  await fetch(`${BASE}/api/projects/${pid}/queue`, json("POST", { action: "pause" }));

  // ── Chats ──
  const list0 = await (await fetch(`${BASE}/api/projects/${pid}/chats`, { headers: { cookie } })).json();
  check("starts with only the main chat", list0.chats.length === 1 && list0.chats[0].id === null && list0.chats[0].title === "Main chat");
  const c1 = (await (await fetch(`${BASE}/api/projects/${pid}/chats`, json("POST", { title: "Pricing ideas" }))).json()).chat;
  const c2 = (await (await fetch(`${BASE}/api/projects/${pid}/chats`, json("POST", {}))).json()).chat;
  check("new chats", c1?.title === "Pricing ideas" && /^Chat \d+$/.test(c2?.title ?? ""), c2?.title);
  await fetch(`${BASE}/api/projects/${pid}/messages`, json("POST", { content: "In the main chat", mode: "ask" }));
  await fetch(`${BASE}/api/projects/${pid}/messages`, json("POST", { content: "In pricing chat", mode: "ask", chatId: c1.id }));
  check("unknown chat refused", (await fetch(`${BASE}/api/projects/${pid}/messages`, json("POST", { content: "x", chatId: "nope" }))).status === 404);
  const main = await (await fetch(`${BASE}/api/projects/${pid}/messages`, { headers: { cookie } })).json();
  const pricing = await (await fetch(`${BASE}/api/projects/${pid}/messages?chat=${c1.id}`, { headers: { cookie } })).json();
  check("each chat has its own messages", main.messages.some((m: { content: string }) => m.content === "In the main chat") && !main.messages.some((m: { content: string }) => m.content === "In pricing chat") && pricing.messages.length === 2 && pricing.messages[0].content === "In pricing chat");
  const reply = await db.message.findFirst({ where: { projectId: pid, chatId: c1.id, role: "ASSISTANT" } });
  check("the agent's reply goes to the same chat", !!reply);
  const page = await (await fetch(`${BASE}/projects/${pid}?chat=${c1.id}`, { headers: { cookie } })).text();
  check("opening ?chat shows that chat", page.includes("In pricing chat") && !page.includes("In the main chat"));
  await fetch(`${BASE}/api/projects/${pid}/chats`, json("PATCH", { chatId: c2.id, title: "Renamed" }));
  const list1 = await (await fetch(`${BASE}/api/projects/${pid}/chats`, { headers: { cookie } })).json();
  check("list with counts and rename", list1.chats.length === 3 && list1.chats.find((c: { id: string }) => c.id === c1.id)?.messages === 2 && list1.chats.some((c: { title: string }) => c.title === "Renamed"));
  check("a chat with queued turns can't be deleted", (await fetch(`${BASE}/api/projects/${pid}/chats?chatId=${c1.id}`, { method: "DELETE", headers: { cookie } })).status === 409);
  check("delete an empty chat", (await fetch(`${BASE}/api/projects/${pid}/chats?chatId=${c2.id}`, { method: "DELETE", headers: { cookie } })).ok);
  check("chats need access", (await fetch(`${BASE}/api/projects/${pid}/chats`)).status === 401);

  // ── Tool-call records ──
  const step = parseStep(`call:${JSON.stringify({ t: "write_file", i: '{"path":"src/App.tsx","content":"…"}', o: "Wrote src/App.tsx" })}`);
  check("call steps parse into Input/Output cards", step?.kind === "call" && step.tool === "write_file" && step.output === "Wrote src/App.tsx" && !step.failed);
  const failed = parseStep(`call:${JSON.stringify({ t: "run_command", i: "npm test", o: "exit 1", e: true })}`);
  check("failed calls are marked", failed?.kind === "call" && failed.failed);
  check("a broken record is ignored", parseStep("call:{not json") === null);

  // ── @Project mentions ──
  const list = [
    { id: "1", name: "Landing page" },
    { id: "2", name: "Admin" },
  ];
  check("mentions with spaces are found", mentionedProjects("Match the header in @Landing page please", list).map((p) => p.id).join() === "1");
  check("no mention, nothing found", mentionedProjects("Make it like the landing page", list).length === 0);

  // ── Traffic anomalies ──
  const days = (vals: number[]) => vals.map((v, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, visits: v }));
  const steady = Array.from({ length: 14 }, (_, i) => 100 + (i % 5) * 3);
  check("steady traffic: nothing", trafficAnomalies(days([...steady, 104, 30])).length === 0);
  check("sharp drop flagged", trafficAnomalies(days([...steady, 12, 40])).some((f) => f.key === "anomaly.traffic-drop" && f.severity === "high"));
  check("spike flagged", trafficAnomalies(days([...steady, 900, 50])).some((f) => f.key === "anomaly.traffic-spike"));
  check("tiny sites aren't judged", trafficAnomalies(days([...Array(14).fill(3), 0, 0])).length === 0);
  const health = await fetch(`${BASE}/api/projects/${pid}/monitoring`, json("POST", { action: "run" }));
  check("health run still works with the anomaly check", health.ok, String(health.status));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) {
    await db.build.updateMany({ where: { projectId: pid, status: "QUEUED" }, data: { status: "CANCELLED" } });
    const del = await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
    check("test project deleted", del.ok, String(del.status));
    await db.projectChat.deleteMany({ where: { projectId: pid } });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
