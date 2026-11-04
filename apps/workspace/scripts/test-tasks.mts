/**
 * IOTx Workspace — Tasks: projects and members, CRUD, subtasks, checklist,
 * links, comments, board moves, My tasks, due dates on the Calendar, overdue,
 * notifications, isolation and permissions.
 *   npx tsx scripts/test-tasks.mts <devToken> <test-users.json>
 */
import { check, OUTSIDER, OWNER, resetMember, setMemberPerm, setup, signIn, summary, ws } from "./lib.mts";

const { MEMBER } = await setup();
const O = await signIn(OWNER, "tasks");
const M = await signIn(MEMBER, "tasks");
const X = await signIn(OUTSIDER, "tasks");
const me = (await ws("/me", undefined, O)).json.me;
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const xid = (await ws("/me", undefined, X)).json.me.id as string;
const ymd = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)).toISOString().slice(0, 10);
};
let pid = "", solo = "";

try {
  // ── Projects
  const p = await ws("/tasks/projects", { name: "T-WS Launch", color: "#4f46e5", memberIds: [mid, xid] }, O);
  pid = p.json.project?.id;
  check("create a project with a colleague", p.status === 201 && p.json.project.memberIds.includes(mid));
  check("people from another workspace can't be added as members", !p.json.project.memberIds.includes(xid));
  const s = await ws("/tasks/projects", { name: "T-WS Private" }, O);
  solo = s.json.project.id;
  const mp = (await ws("/tasks/projects", undefined, M)).json.projects as any[];
  check("members see projects they belong to, not others", mp.some((x) => x.id === pid) && !mp.some((x) => x.id === solo));
  check("a project needs a name", (await ws("/tasks/projects", { name: " " }, O)).status === 400);

  // ── Tasks
  const t1 = await ws("/tasks", { projectId: pid, title: "T-Write the brief", priority: 2, due: ymd(3), labels: ["docs", "q4"], assigneeId: mid, description: "One page" }, O);
  check("create a task with assignee, due date, priority and labels", t1.status === 201 && t1.json.task.assigneeId === mid && t1.json.task.due === ymd(3) && t1.json.task.priority === 2 && t1.json.task.labels.join() === "docs,q4");
  const tid = t1.json.task.id as string;
  const mn = (await ws("/notifications", undefined, M)).json.items as any[];
  check("assignment notifies the assignee", mn.some((n) => n.kind === "task.assigned" && n.title.includes("T-Write the brief") && n.link.includes(tid)));
  const t2 = await ws("/tasks", { projectId: pid, title: "T-Book venue", due: ymd(-2) }, O);
  const t3 = await ws("/tasks", { projectId: pid, title: "T-Order swag", status: "doing" }, O);
  check("a title is required", (await ws("/tasks", { projectId: pid, title: "" }, O)).status === 400);
  check("a bad due date is refused", (await ws("/tasks", { projectId: pid, title: "x", due: "next week" }, O)).status === 400);
  check("the assignee must be in the project", (await ws("/tasks", { projectId: solo, title: "x", assigneeId: mid }, O)).status === 400);
  let list = (await ws(`/tasks?projectId=${pid}`, undefined, O)).json.tasks as any[];
  check("list a project's tasks", list.length === 3);
  check("overdue tasks are flagged", list.find((t) => t.id === t2.json.task.id)?.overdue === true && list.find((t) => t.id === tid)?.overdue === false);

  // ── Subtasks, checklist, links, comments
  const sub = await ws("/tasks", { projectId: pid, parentId: tid, title: "T-Outline" }, O);
  await ws("/tasks", { projectId: pid, parentId: tid, title: "T-Draft" }, O);
  await ws(`/tasks/${sub.json.task.id}`, { status: "done" }, O, "PATCH");
  list = (await ws(`/tasks?projectId=${pid}`, undefined, O)).json.tasks;
  check("subtasks stay under their parent and are counted", list.length === 3 && list.find((t) => t.id === tid).subtasks.done === 1 && list.find((t) => t.id === tid).subtasks.total === 2);
  const up = await ws(`/tasks/${tid}`, { checklist: [{ text: "Goals", done: true }, { text: "Budget", done: false }], links: [{ url: "https://docs.example.com/brief", title: "Brief" }, { url: "javascript:alert(1)" }] }, O, "PATCH");
  check("checklist and links (only http/https links are kept)", up.json.task.checklist.length === 2 && up.json.task.links.length === 1 && up.json.task.links[0].url === "https://docs.example.com/brief");
  const cm = await ws(`/tasks/${tid}/comments`, { body: "Started on this" }, M);
  check("comment on a task", cm.status === 201);
  check("a comment notifies the task's creator", (await ws("/notifications", undefined, O)).json.items.some((n: any) => n.kind === "task.comment" && n.body === "Started on this"));
  const det = (await ws(`/tasks/${tid}`, undefined, O)).json;
  check("task detail has subtasks and comments", det.subtasks.length === 2 && det.comments.length === 1 && det.task.comments === 1);
  check("an empty comment is refused", (await ws(`/tasks/${tid}/comments`, { body: "  " }, O)).status === 400);

  // ── Board moves
  const mv = await ws(`/tasks/${t2.json.task.id}`, { status: "review", position: 500 }, O, "PATCH");
  check("move a card to another column", mv.json.task.status === "review" && mv.json.task.position === 500);
  await ws(`/tasks/${t3.json.task.id}`, { status: "review", position: 250 }, O, "PATCH");
  list = (await ws(`/tasks?projectId=${pid}`, undefined, O)).json.tasks;
  const review = list.filter((t) => t.status === "review").map((t) => t.title);
  check("cards keep their order within a column", review.join() === "T-Order swag,T-Book venue", review);
  const dn = await ws(`/tasks/${t2.json.task.id}`, { status: "done" }, O, "PATCH");
  check("done tasks stop being overdue", dn.json.task.overdue === false && dn.json.task.status === "done");
  check("an unknown status is refused", (await ws(`/tasks/${tid}`, { status: "blocked" }, O, "PATCH")).status === 400);

  // ── My tasks and the calendar
  const mine = (await ws("/tasks?mine=1", undefined, M)).json.tasks as any[];
  check("My tasks lists what's assigned to me across projects", mine.some((x) => x.id === tid) && mine.every((x) => x.assigneeId === mid));
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString(), to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const cal = (await ws(`/calendar?from=${from}&to=${to}&sync=0`, undefined, M)).json;
  const due = cal.tasks.find((t: any) => t.id === tid);
  check("due dates appear on the Calendar as all-day items", due?.due === ymd(3) && due.project === "T-WS Launch");
  const reassign = await ws(`/tasks/${tid}`, { assigneeId: me.id }, M, "PATCH");
  check("members can reassign (they have “Assign to others”)", reassign.status === 200);

  // ── Isolation
  check("an outsider can't see the project's tasks", (await ws(`/tasks?projectId=${pid}`, undefined, X)).status === 404);
  check("an outsider can't open, edit, comment or delete a task", (await ws(`/tasks/${tid}`, undefined, X)).status === 404 && (await ws(`/tasks/${tid}`, { title: "x" }, X, "PATCH")).status === 404 && (await ws(`/tasks/${tid}/comments`, { body: "x" }, X)).status === 404 && (await ws(`/tasks/${tid}`, undefined, X, "DELETE")).status === 404);
  check("an outsider can't add tasks to it", (await ws("/tasks", { projectId: pid, title: "x" }, X)).status === 404);
  check("an outsider's calendar doesn't show these due dates", !(await ws(`/calendar?from=${from}&to=${to}&sync=0`, undefined, X)).json.tasks?.some((t: any) => t.id === tid));
  check("a member outside a project can't see it", (await ws(`/tasks/${(await ws("/tasks", { projectId: solo, title: "T-secret" }, O)).json.task.id}`, undefined, M)).status === 404);

  // ── Permissions
  check("members can't delete tasks by default (risky switch)", (await ws(`/tasks/${t3.json.task.id}`, undefined, M, "DELETE")).status === 403);
  await setMemberPerm({ "tasks.delete": true });
  const M2 = await signIn(MEMBER, "tasks");
  check("with “Delete tasks” turned on, they can", (await ws(`/tasks/${t3.json.task.id}`, undefined, M2, "DELETE")).status === 200);
  await setMemberPerm({ "tasks.assign": false, "tasks.project.create": false });
  const M3 = await signIn(MEMBER, "tasks");
  check("without “Assign to others”, assigning someone else is refused", (await ws("/tasks", { projectId: pid, title: "x", assigneeId: me.id }, M3)).status === 403);
  check("…assigning themselves is fine", (await ws("/tasks", { projectId: pid, title: "T-mine", assigneeId: mid }, M3)).status === 201);
  check("without “Create projects”, creating one is refused", (await ws("/tasks/projects", { name: "x" }, M3)).status === 403);
  await setMemberPerm({ "tasks.create": false });
  check("without “Create tasks”, creating one is refused", (await ws("/tasks", { projectId: pid, title: "x" }, await signIn(MEMBER, "tasks"))).status === 403);
  check("only the project's creator can change its members", (await ws(`/tasks/projects/${pid}`, { memberIds: [] }, M, "PATCH")).status === 403);
  await ws(`/tasks/${tid}`, undefined, O, "DELETE");
  check("deleting a task removes its subtasks", (await ws(`/tasks/${sub.json.task.id}`, undefined, O)).status === 404);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  await resetMember().catch(() => {});
  for (const id of [pid, solo]) if (id) await ws(`/tasks/projects/${id}`, { archived: true }, O, "PATCH").catch(() => {});
}
process.exit(summary("Tasks") ? 1 : 0);
