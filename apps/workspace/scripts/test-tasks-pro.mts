/**
 * IOTx Workspace: Tasks as a tracker. Issue keys and types, epics, custom
 * workflow and WIP limits, sprints and the backlog, history, mentions and
 * watchers, links, time logs, attachments, filters, bulk edit, moving between
 * projects, project roles, rules, repeating issues, reports and CSV.
 *   npx tsx scripts/test-tasks-pro.mts <devToken> <test-users.json>
 */
import { check, OWNER, setup, signIn, summary, WS, ws } from "./lib.mts";

const { MEMBER } = await setup();
const O = await signIn(OWNER, "tasks");
const M = await signIn(MEMBER, "tasks");
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const oid = (await ws("/me", undefined, O)).json.me.id as string;
const mname = (await ws("/me", undefined, M)).json.me.name as string;
const ymd = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)).toISOString().slice(0, 10);
};
const made: string[] = [];

try {
  // ── Project and keys
  const p = await ws("/tasks/projects", { name: "Pro Tracker Test", memberIds: [mid] }, O);
  const pid = p.json.project?.id as string;
  made.push(pid);
  check("a new project gets a key from its name", p.status === 201 && /^PTT\d*$/.test(p.json.project.key), p.json);
  const key = p.json.project.key as string;
  check("it starts with the default workflow", p.json.project.statuses.map((s: any) => s.id).join() === "todo,doing,review,done");
  const p2 = await ws("/tasks/projects", { name: "Pro Tracker Two", key: key }, O);
  made.push(p2.json.project.id);
  check("keys stay unique in the workspace", p2.status === 201 && p2.json.project.key !== key, p2.json.project?.key);
  check("a bad key is refused", (await ws(`/tasks/projects/${pid}`, { key: "1x" }, O, "PATCH")).status === 400);

  // ── Issues
  const epic = (await ws("/tasks", { projectId: pid, type: "epic", title: "Checkout revamp" }, O)).json.task;
  const a = await ws("/tasks", { projectId: pid, type: "story", title: "Pay with UPI", epicId: epic.id, points: 5, assigneeId: mid, start: ymd(0), due: ymd(5), labels: ["payments"] }, O);
  check("issues get keys in order (epic 1, story 2)", epic.key === `${key}-1` && a.json.task.key === `${key}-2`, [epic.key, a.json.task?.key]);
  check("type, epic, points, start and due are kept", a.json.task.type === "story" && a.json.task.epicId === epic.id && a.json.task.points === 5 && a.json.task.start === ymd(0));
  const aid = a.json.task.id as string;
  check("an issue opens by its key", (await ws(`/tasks/${key}-2`, undefined, O)).json.task?.id === aid);
  check("the start can't be after the due date", (await ws("/tasks", { projectId: pid, title: "x", start: ymd(3), due: ymd(1) }, O)).status === 400);
  check("an epic from another project is refused", (await ws("/tasks", { projectId: p2.json.project.id, title: "x", epicId: epic.id }, O)).status === 400);
  const sub = await ws("/tasks", { projectId: pid, parentId: aid, title: "Add UPI QR" }, O);
  check("a subtask is typed as a subtask", sub.json.task?.type === "subtask");
  check("subtasks can't have subtasks", (await ws("/tasks", { projectId: pid, parentId: sub.json.task.id, title: "deeper" }, O)).status === 400);
  const b = (await ws("/tasks", { projectId: pid, type: "bug", title: "Coupon breaks total", priority: 3 }, O)).json.task;

  // ── History, watching, mentions
  await ws(`/tasks/${aid}`, { status: "doing", priority: 2 }, O, "PATCH");
  const d1 = (await ws(`/tasks/${aid}`, undefined, O)).json;
  check("every change is in the history with before and after", d1.activity.some((x: any) => x.field === "status" && x.from === "To do" && x.to === "In progress") && d1.activity.some((x: any) => x.field === "priority" && x.to === "High") && d1.activity.some((x: any) => x.kind === "created"));
  check("the creator and the assignee watch the issue", d1.task.watchers.includes(oid) && d1.task.watchers.includes(mid));
  const mn = (await ws("/notifications", undefined, M)).json.items as any[];
  check("watchers hear about status changes", mn.some((n) => n.title.includes(`${key}-2`) && /In progress/.test(n.title)));
  const c = await ws(`/tasks/${b.id}/comments`, { body: `@${mname} can you look at this?` }, O);
  check("a comment @mention notifies that person and makes them a watcher", c.status === 201 && ((await ws("/notifications", undefined, M)).json.items as any[]).some((n) => n.kind === "task.mention") && (await ws(`/tasks/${b.id}`, undefined, O)).json.task.watchers.includes(mid));
  const cid = c.json.comment.id;
  check("someone else can't edit your comment", (await ws(`/tasks/comments/${cid}`, { body: "hijack" }, M, "PATCH")).status === 403);
  const ed = await ws(`/tasks/comments/${cid}`, { body: "Edited text" }, O, "PATCH");
  check("you can edit your comment (marked edited)", ed.json.comment?.body === "Edited text" && !!ed.json.comment.editedAt);
  check("and delete it", (await ws(`/tasks/comments/${cid}`, undefined, O, "DELETE")).status === 200);
  await ws(`/tasks/${b.id}/watch`, { on: false }, M);
  check("you can stop watching", !(await ws(`/tasks/${b.id}`, undefined, O)).json.task.watchers.includes(mid));

  // ── Links
  const l = await ws(`/tasks/${b.id}/links`, { kind: "blocks", other: `${key}-2` }, O);
  check("link issues by key (blocks)", l.status === 201);
  const ld = (await ws(`/tasks/${aid}`, undefined, O)).json.issueLinks as any[];
  check("the other side reads 'is blocked by'", ld.some((x) => x.label === "is blocked by" && x.task.id === b.id));
  check("a duplicate link is refused", (await ws(`/tasks/${b.id}/links`, { kind: "blocks", other: aid }, O)).status === 400);
  check("an issue can't link to itself", (await ws(`/tasks/${b.id}/links`, { kind: "relates", other: b.id }, O)).status === 400);

  // ── Time
  check("log time as '1h 30m'", (await ws(`/tasks/${aid}/worklogs`, { time: "1h 30m", note: "Spike" }, M)).json.worklog?.minutes === 90);
  check("nonsense time is refused", (await ws(`/tasks/${aid}/worklogs`, { time: "soon" }, M)).status === 400);
  check("logged time adds up on the issue", (await ws(`/tasks?projectId=${pid}`, undefined, O)).json.tasks.find((t: any) => t.id === aid)?.loggedMin === 90);

  // ── Attachments
  const form = new FormData();
  form.append("file", new Blob(["hello receipt"], { type: "text/plain" }), "receipt.txt");
  const up = await fetch(`${WS}/api/tasks/${aid}/attachments`, { method: "POST", headers: { cookie: O }, body: form });
  const att = (await up.json()).attachment;
  check("attach a file", up.status === 201 && att?.name === "receipt.txt");
  const dl = await fetch(`${WS}/api/tasks/attachments/${att.id}`, { headers: { cookie: M } });
  check("project members can open it, sandboxed", dl.status === 200 && (await dl.text()) === "hello receipt" && /sandbox/.test(dl.headers.get("content-security-policy") ?? ""));
  const X = await signIn(`authjs.session-token=${JSON.parse((await import("node:fs")).readFileSync(process.argv[3], "utf8"))["outsider@localhost"]}`, "tasks");
  check("people outside the project can't", (await fetch(`${WS}/api/tasks/attachments/${att.id}`, { headers: { cookie: X } })).status === 404);

  // ── Workflow and WIP
  const wf = await ws(`/tasks/projects/${pid}`, { statuses: [
    { id: "todo", name: "Backlog", category: "todo" },
    { id: "doing", name: "Building", category: "doing", wip: 1 },
    { name: "QA", category: "doing", color: "#9333ea" },
    { id: "review", name: "Review", category: "doing" },
    { id: "done", name: "Shipped", category: "done" },
    { name: "Won't do", category: "done" },
  ] }, O, "PATCH");
  check("a custom workflow with your own statuses", wf.status === 200 && wf.json.project.statuses.map((s: any) => s.name).join() === "Backlog,Building,QA,Review,Shipped,Won't do", wf.json);
  check("removing a status still in use is refused", (await ws(`/tasks/projects/${pid}`, { statuses: [{ id: "todo", name: "A", category: "todo" }, { id: "done", name: "B", category: "done" }] }, O, "PATCH")).status === 400);
  const wip = await ws(`/tasks/${b.id}`, { status: "doing" }, O, "PATCH");
  check("the WIP limit stops a second issue going into Building", wip.status === 409 && wip.json.wip === true);
  const wont = await ws(`/tasks/${b.id}`, { status: "won_t_do" }, O, "PATCH");
  check("any status in the Done group completes the issue", wont.json.task?.done === true && !!wont.json.task.completedAt, wont.json);

  // ── Sprints and backlog
  const s1 = (await ws(`/tasks/projects/${pid}/sprints`, {}, O)).json.sprint;
  const s2 = (await ws(`/tasks/projects/${pid}/sprints`, { name: "Next" }, O)).json.sprint;
  check("sprints are named after the project", s1.name === `${key} Sprint 1`);
  await ws(`/tasks/${aid}`, { sprintId: s1.id }, O, "PATCH");
  const c2 = (await ws("/tasks", { projectId: pid, title: "Receipts email", points: 3, sprintId: s1.id }, O)).json.task;
  check("the backlog lists issues with no sprint", !(await ws(`/tasks?projectId=${pid}&sprint=backlog`, undefined, O)).json.tasks.some((t: any) => t.id === aid));
  const st = await ws(`/tasks/sprints/${s1.id}`, { action: "start", endAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }, O, "PATCH");
  check("start a sprint", st.json.sprint?.state === "active" && st.json.sprint.stats.start.points === 8, st.json);
  check("only one sprint runs at a time", (await ws(`/tasks/sprints/${s2.id}`, { action: "start" }, O, "PATCH")).status === 400);
  check("filter by the running sprint", (await ws(`/tasks?projectId=${pid}&sprint=active`, undefined, O)).json.tasks.length === 2);
  await ws(`/tasks/${c2.id}`, { status: "done" }, O, "PATCH");
  const bd = await ws(`/tasks/projects/${pid}/reports?kind=burndown`, undefined, O);
  check("burndown shows what's left today", bd.json.sprint?.id === s1.id && bd.json.points.at(-1)?.remaining === 5, bd.json);
  const done = await ws(`/tasks/sprints/${s1.id}`, { action: "complete", moveTo: s2.id }, O, "PATCH");
  check("completing a sprint carries unfinished work to the next", done.json.sprint?.state === "closed" && done.json.sprint.stats.carried === 1 && (await ws(`/tasks/${aid}`, undefined, O)).json.task.sprintId === s2.id);
  const vel = (await ws(`/tasks/projects/${pid}/reports?kind=velocity`, undefined, O)).json.sprints;
  check("velocity: committed 8, completed 3", vel.length === 1 && vel[0].committed === 8 && vel[0].completed === 3, vel);
  const fl = (await ws(`/tasks/projects/${pid}/reports?kind=flow&days=7`, undefined, O)).json.days;
  check("created vs resolved and flow for each day", fl.length === 7 && fl.at(-1).created >= 4 && fl.at(-1).resolved >= 2 && fl.at(-1).done >= 2, fl.at(-1));
  check("workload per person", ((await ws(`/tasks/projects/${pid}/reports?kind=workload`, undefined, O)).json.people as any[]).some((x) => x.assigneeId === mid && x.points === 5));

  // ── Filters, search, sort, bulk
  check("search finds by text", (await ws(`/tasks?projectId=${pid}&text=upi`, undefined, O)).json.tasks.some((t: any) => t.id === aid));
  check("search finds by key", (await ws(`/tasks?text=${key}-2`, undefined, O)).json.tasks.some((t: any) => t.id === aid));
  check("filter by type, assignee and label", (await ws(`/tasks?projectId=${pid}&type=story&assignee=${mid}&label=payments`, undefined, O)).json.tasks.length === 1);
  const sorted = (await ws(`/tasks?projectId=${pid}&sort=priority`, undefined, O)).json.tasks as any[];
  check("sort by priority", sorted[0].priority >= sorted[sorted.length - 1].priority);
  const f = await ws("/tasks/filters", { name: "My payments", query: { projectId: pid, label: "payments" }, shared: true }, O);
  check("save a filter and share it", f.status === 201 && ((await ws("/tasks/filters", undefined, M)).json.filters as any[]).some((x) => x.id === f.json.filter.id));
  check("others can't delete your filter", (await ws(`/tasks/filters?id=${f.json.filter.id}`, undefined, M, "DELETE")).status === 404);
  const bulk = await ws("/tasks/bulk", { ids: [aid, c2.id, epic.id], patch: { labels: ["q4"], priority: 1 } }, O);
  check("bulk edit several issues", bulk.json.updated === 3);
  check("bulk edit is checked per issue", (await ws("/tasks/bulk", { ids: [aid], patch: { status: "nope" } }, O)).json.results[0].ok === false);

  // ── Clone and move
  const cl = await ws(`/tasks/${aid}/clone`, {}, O);
  check("clone an issue with its subtasks, linked as a clone", cl.status === 201 && cl.json.task.subtasks.total === 1 && cl.json.task.issueLinks === 1);
  const mv = await ws(`/tasks/${cl.json.task.id}`, { projectId: p2.json.project.id }, O, "PATCH");
  check("move an issue to another project: it gets that project's key", mv.status === 200 && mv.json.task.key.startsWith(p2.json.project.key) && mv.json.task.sprintId === null, mv.json);

  // ── Roles
  await ws(`/tasks/projects/${pid}`, { members: [{ userId: oid, role: "admin" }, { userId: mid, role: "viewer" }] }, O, "PATCH");
  check("a viewer can read", (await ws(`/tasks/${aid}`, undefined, M)).status === 200);
  check("but not change issues", (await ws(`/tasks/${aid}`, { title: "nope" }, M, "PATCH")).status === 403);
  check("or project settings", (await ws(`/tasks/projects/${pid}`, { name: "nope" }, M, "PATCH")).status === 403);
  await ws(`/tasks/projects/${pid}`, { members: [{ userId: oid, role: "admin" }, { userId: mid, role: "member" }] }, O, "PATCH");

  // ── Rules
  const r = await ws(`/tasks/projects/${pid}/rules`, { name: "Shipped goes to the reporter", trigger: { on: "status", status: "done" }, actions: [{ do: "assign", value: "reporter" }, { do: "label", value: "shipped" }] }, O);
  check("an automation rule", r.status === 201);
  const rt = (await ws("/tasks", { projectId: pid, title: "Rule target", assigneeId: mid }, M)).json.task;
  await ws(`/tasks/${rt.id}`, { status: "done" }, M, "PATCH");
  await new Promise((res) => setTimeout(res, 600));
  const rd = (await ws(`/tasks/${rt.id}`, undefined, O)).json.task;
  check("runs when an issue reaches that status", rd.assigneeId === mid && rd.labels.includes("shipped"), rd);
  check("only project admins edit rules", (await ws(`/tasks/projects/${pid}/rules`, { name: "x", trigger: { on: "created" }, actions: [{ do: "label", value: "x" }] }, M)).status === 403);

  // ── Repeating issues
  const rec = await ws(`/tasks/projects/${pid}/recurring`, { template: { title: "Weekly report", dueInDays: 2 }, rule: { every: "week", interval: 1 }, startAt: new Date(Date.now() - 1000).toISOString() }, O);
  check("set up a repeating issue", rec.status === 201);
  const { envOf } = await import("./lib.mts");
  const key0 = envOf(".env").IOTX_SERVICE_KEY;
  const tick = await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "x-iotx-key": key0, "content-type": "application/json" }, body: JSON.stringify({ job: "recurring" }) });
  const made1 = (await tick.json()).made;
  const weekly = (await ws(`/tasks?projectId=${pid}&text=Weekly report`, undefined, O)).json.tasks as any[];
  check("when it's time, the issue is made (with its due date) and the next run moves a week on", made1 >= 1 && weekly.length === 1 && weekly[0].due === ymd(2) && new Date((await ws(`/tasks/projects/${pid}/recurring`, undefined, O)).json.recurring[0].nextAt).getTime() > Date.now() + 5 * 86_400_000);

  // ── Custom fields, templates, query language
  const fd = await ws(`/tasks/projects/${pid}`, { fieldDefs: [{ name: "Customer", type: "select", options: ["Acme", "Globex"] }, { name: "Hours saved", type: "number" }, { name: "Owner", type: "user" }] }, O, "PATCH");
  const defs = fd.json.project?.fieldDefs as any[];
  check("define custom fields (choice, number, person)", fd.status === 200 && defs?.length === 3 && defs.every((d) => /^f_/.test(d.id)), fd.json);
  check("a choice field needs choices", (await ws(`/tasks/projects/${pid}`, { fieldDefs: [{ name: "Empty", type: "select", options: [] }] }, O, "PATCH")).status === 400);
  const cf = await ws(`/tasks/${aid}`, { custom: { [defs[0].id]: "Acme", [defs[1].id]: "12", [defs[2].id]: mid } }, O, "PATCH");
  check("set custom field values on an issue", cf.json.task?.custom?.[defs[0].id] === "Acme" && cf.json.task.custom[defs[1].id] === 12 && cf.json.task.custom[defs[2].id] === mid, cf.json);
  check("a value outside the choices is refused", (await ws(`/tasks/${aid}`, { custom: { [defs[0].id]: "Initech" } }, O, "PATCH")).status === 400);
  check("a person field takes project members only", (await ws(`/tasks/${aid}`, { custom: { [defs[2].id]: "nobody" } }, O, "PATCH")).status === 400);
  check("custom field changes are in the history", ((await ws(`/tasks/${aid}`, undefined, O)).json.activity as any[]).some((x) => x.field === "custom:Customer" && x.to === "Acme"));
  const tp = await ws(`/tasks/projects/${pid}`, { templates: [{ name: "Bug report", type: "bug", title: "[Bug] ", description: "**Steps**", labels: ["triage"], priority: 2 }] }, O, "PATCH");
  check("issue templates", tp.json.project?.templates?.[0]?.name === "Bug report" && tp.json.project.templates[0].type === "bug");
  const q = async (text: string) => ws(`/tasks?q=${encodeURIComponent(text)}`, undefined, O);
  const q1 = await q(`project = ${key} AND type = story ORDER BY points DESC`);
  check("query: project and type, sorted", q1.status === 200 && q1.json.tasks.some((t: any) => t.id === aid) && q1.json.tasks.every((t: any) => t.type === "story"), q1.json);
  check("query: assignee and text search", (await q(`assignee = "${mname}" AND text ~ "UPI"`)).json.tasks?.some((t: any) => t.id === aid));
  check("query: labels in, status category, not", (await q(`project = ${key} AND labels in (payments, q4) AND statusCategory != done`)).json.tasks?.every((t: any) => !t.done));
  check("query: dates and is empty", (await q(`project = ${key} AND due < +30d AND epic is not empty`)).json.tasks?.some((t: any) => t.id === aid));
  check("query: OR with brackets", (await q(`project = ${key} AND (type = bug OR type = epic)`)).json.tasks?.every((t: any) => ["bug", "epic"].includes(t.type)));
  const bq = await q("assignee == me");
  check("a broken query explains what's wrong", bq.status === 400 && typeof bq.json.error === "string" && bq.json.error.length > 10, bq.json);
  check("an unknown field is named in the error", /colour/.test((await q("colour = red")).json.error ?? ""));

  // ── CSV
  const csv = await fetch(`${WS}/api/tasks/export?projectId=${pid}`, { headers: { cookie: O } });
  const text = await csv.text();
  check("export to CSV with keys, status names and custom fields", csv.status === 200 && text.includes(`${key}-2`) && text.includes("Pay with UPI") && /Shipped|Building|Backlog/.test(text) && text.split("\n")[0].includes("Customer") && text.includes("Acme"));
  const imp = await fetch(`${WS}/api/tasks/projects/${p2.json.project.id}/import`, { method: "POST", headers: { cookie: O, "content-type": "text/csv" }, body: 'Title,Type,Priority,Labels,Due\n"Import, with comma",bug,High,a;b,2030-01-02\n,task,,,\nSecond one,story,Low,,\n' });
  const ij = await imp.json();
  check("import from CSV, with a clear error for a row with no title", ij.created === 2 && ij.errors.length === 1 && ij.errors[0].row === 3, ij);
  check("CSV formulas are neutralised on export", !(await (await fetch(`${WS}/api/tasks/export?projectId=${p2.json.project.id}`, { headers: { cookie: O } })).text()).split("\n").some((ln) => /,=/.test(ln)));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of made) await ws(`/tasks/projects/${id}`, { archived: true }, O, "PATCH").catch(() => null);
  process.exit(summary("Tasks (tracker)") ? 1 : 0);
}
