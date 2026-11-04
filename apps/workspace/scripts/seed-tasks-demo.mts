/**
 * A realistic demo project for trying Tasks locally: epics, a running sprint,
 * a planned sprint, issues in every status, labels, points, subtasks, links,
 * comments and logged time. Safe to re-run: it archives the previous demo.
 *   npx tsx scripts/seed-tasks-demo.mts <devToken> <test-users.json>
 */
import { OWNER, setup, signIn, ws } from "./lib.mts";

const { MEMBER } = await setup();
const O = await signIn(OWNER, "tasks");
const M = await signIn(MEMBER, "tasks");
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const oid = (await ws("/me", undefined, O)).json.me.id as string;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

for (const p of (await ws("/tasks/projects", undefined, O)).json.projects as any[]) if (p.name === "Website relaunch") await ws(`/tasks/projects/${p.id}`, { archived: true }, O, "PATCH");

const p = (await ws("/tasks/projects", { name: "Website relaunch", key: "WEB", color: "#4f46e5", description: "New marketing site and checkout.", memberIds: [mid] }, O)).json.project;
await ws(`/tasks/projects/${p.id}`, { labelDefs: [{ name: "frontend", color: "#0891b2" }, { name: "backend", color: "#7c3aed" }, { name: "design", color: "#db2777" }, { name: "seo", color: "#16a34a" }] }, O, "PATCH");
const add = async (b: Record<string, unknown>) => (await ws("/tasks", { projectId: p.id, ...b }, O)).json.task;

const e1 = await add({ type: "epic", title: "New checkout", start: day(-10), due: day(18) });
const e2 = await add({ type: "epic", title: "Marketing pages", start: day(-4), due: day(30) });
const e3 = await add({ type: "epic", title: "Search engine visibility", start: day(10), due: day(45) });
const s1 = (await ws(`/tasks/projects/${p.id}/sprints`, { goal: "Customers can pay by card and UPI" }, O)).json.sprint;
const s2 = (await ws(`/tasks/projects/${p.id}/sprints`, { goal: "Launch the pricing page" }, O)).json.sprint;

const issues = [
  { type: "story", title: "Pay with UPI at checkout", epicId: e1.id, points: 5, assigneeId: mid, labels: ["frontend", "backend"], priority: 2, sprintId: s1.id, status: "doing", start: day(-3), due: day(4), description: "As a shopper I can pay with any UPI app.\n\n**Acceptance**\n- [x] QR code on desktop\n- [ ] Intent link on phones\n- [ ] Payment status polled until done" },
  { type: "story", title: "Card payments with saved cards", epicId: e1.id, points: 8, assigneeId: oid, labels: ["backend"], priority: 2, sprintId: s1.id, status: "todo", due: day(9) },
  { type: "bug", title: "Coupon code breaks the order total", epicId: e1.id, points: 2, assigneeId: mid, labels: ["backend"], priority: 3, sprintId: s1.id, status: "review", due: day(-1) },
  { type: "task", title: "Order confirmation email", epicId: e1.id, points: 3, assigneeId: oid, labels: ["backend"], sprintId: s1.id, status: "done" },
  { type: "story", title: "Address autocomplete", epicId: e1.id, points: 3, labels: ["frontend"], sprintId: s1.id, status: "todo" },
  { type: "task", title: "Design the pricing page", epicId: e2.id, points: 3, assigneeId: oid, labels: ["design"], sprintId: s2.id, start: day(6), due: day(12) },
  { type: "story", title: "Pricing page with plan comparison", epicId: e2.id, points: 5, labels: ["frontend"], sprintId: s2.id, start: day(10), due: day(20) },
  { type: "task", title: "Customer stories section", epicId: e2.id, points: 2, labels: ["design", "frontend"] },
  { type: "task", title: "Sitemap and robots.txt", epicId: e3.id, points: 1, labels: ["seo"] },
  { type: "story", title: "Page titles and descriptions for every page", epicId: e3.id, points: 3, labels: ["seo"] },
  { type: "bug", title: "Footer links overlap on small phones", points: 1, labels: ["frontend"], priority: 1 },
];
const made: any[] = [];
for (const i of issues) made.push(await add(i));
await ws(`/tasks/${made[0].id}/worklogs`, { time: "3h", note: "QR flow" }, M);
await ws(`/tasks/${made[0].id}`, { estimateMin: 600 }, O, "PATCH");
await add({ parentId: made[0].id, title: "Generate the UPI QR code", assigneeId: mid, status: "done" });
await add({ parentId: made[0].id, title: "Poll payment status", assigneeId: mid });
await ws(`/tasks/${made[2].id}/links`, { kind: "blocks", other: made[0].key }, O);
await ws(`/tasks/${made[0].id}/comments`, { body: "QR works on desktop. Phones next. @Dev User can you check the copy?" }, M);
await ws(`/tasks/sprints/${s1.id}`, { action: "start", startAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), endAt: new Date(Date.now() + 9 * 86_400_000).toISOString() }, O, "PATCH");
console.log(`Demo project ${p.key} ready with ${made.length + 5} issues.`);
