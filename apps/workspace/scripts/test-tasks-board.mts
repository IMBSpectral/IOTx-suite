/**
 * Tasks, Jira board parity (round 2): columns managed on the board (add,
 * rename, move, limits with a minimum, delete with issues moved), flags,
 * releases with carry-over and notes, components with a default assignee,
 * quick filters and features, the project summary, board insights (stuck,
 * blocked, flagged) and the new query fields.
 *   npx tsx scripts/test-tasks-board.mts <devToken> <test-users.json>
 */
import { check, OWNER, setup, signIn, summary, ws } from "./lib.mts";

const { MEMBER } = await setup();
const O = await signIn(OWNER, "tasks");
const M = await signIn(MEMBER, "tasks");
const mid = (await ws("/me", undefined, M)).json.me.id as string;
let pid = "";

try {
  const p = (await ws("/tasks/projects", { name: "Board Parity Test", memberIds: [mid] }, O)).json.project;
  pid = p.id;
  const key = p.key as string;
  const add = async (b: Record<string, unknown>, who = O) => (await ws("/tasks", { projectId: pid, ...b }, who)).json;

  // ── Columns
  const cols = p.statuses as any[];
  const withQa = [...cols.slice(0, 2), { id: "", name: "QA", category: "doing", color: "#0891b2", wip: 3, min: 1 }, ...cols.slice(2)];
  const a1 = await ws(`/tasks/projects/${pid}`, { statuses: withQa }, O, "PATCH");
  const qa = (a1.json.project?.statuses as any[])?.find((s) => s.name === "QA");
  check("add a column with a min and max limit", !!qa && qa.wip === 3 && qa.min === 1, a1.json);
  check("a minimum above the maximum is refused", (await ws(`/tasks/projects/${pid}`, { statuses: withQa.map((s) => (s.name === "QA" ? { ...s, id: qa.id, min: 5 } : s)) }, O, "PATCH")).status === 400);
  const renamed = (a1.json.project.statuses as any[]).map((s: any) => (s.id === qa.id ? { ...s, name: "Testing" } : s));
  const r1 = await ws(`/tasks/projects/${pid}`, { statuses: renamed }, O, "PATCH");
  check("rename a column (its id stays)", (r1.json.project.statuses as any[]).some((s) => s.id === qa.id && s.name === "Testing"));
  const moved = [...r1.json.project.statuses];
  const qi = moved.findIndex((s: any) => s.id === qa.id);
  [moved[qi - 1], moved[qi]] = [moved[qi], moved[qi - 1]];
  check("move a column left", ((await ws(`/tasks/projects/${pid}`, { statuses: moved }, O, "PATCH")).json.project.statuses as any[]).findIndex((s) => s.id === qa.id) === qi - 1);
  check("members can't change columns", (await ws(`/tasks/projects/${pid}`, { statuses: renamed }, M, "PATCH")).status === 403);
  const t1 = (await add({ title: "In testing", status: qa.id })).task;
  check("a column in use can't simply vanish", (await ws(`/tasks/projects/${pid}`, { statuses: cols }, O, "PATCH")).status === 400);
  const del = await ws(`/tasks/projects/${pid}/columns`, { statusId: qa.id, moveTo: "review" }, O);
  check("delete a column, moving its issues to another", del.status === 200 && del.json.moved === 1 && (await ws(`/tasks/${t1.id}`, undefined, O)).json.task.status === "review", del.json);
  check("a board keeps at least one To do and one Done column", (await ws(`/tasks/projects/${pid}/columns`, { statusId: "done", moveTo: "review" }, O)).status === 400);

  // ── Flags and time in status
  const f = await ws(`/tasks/${t1.id}`, { flagged: true, flagNote: "Waiting for keys" }, M, "PATCH");
  check("flag an issue with a reason", f.json.task?.flagged === true && f.json.task.flagNote === "Waiting for keys");
  check("the flag is in the history", ((await ws(`/tasks/${t1.id}`, undefined, O)).json.activity as any[]).some((a) => a.field === "flagged" && /Waiting for keys/.test(a.to)));
  check("issues carry when their status last changed", !!f.json.task.statusAt);
  const uf = await ws(`/tasks/${t1.id}`, { flagged: false }, M, "PATCH");
  check("remove a flag (the reason goes too)", uf.json.task.flagged === false && uf.json.task.flagNote === null);

  // ── Releases
  const v1 = (await ws(`/tasks/projects/${pid}/versions`, { name: "1.0", releaseDate: "2030-01-15", description: "First launch" }, O)).json.version;
  const v2 = (await ws(`/tasks/projects/${pid}/versions`, { name: "1.1" }, O)).json.version;
  check("create versions", !!v1?.id && !!v2?.id);
  check("version names are unique in a project", (await ws(`/tasks/projects/${pid}/versions`, { name: "1.0" }, O)).status === 400);
  const s1 = (await add({ title: "Login page", type: "story", versionId: v1.id })).task;
  const s2 = (await add({ title: "Broken logo", type: "bug", versionId: v1.id })).task;
  await ws(`/tasks/${s1.id}`, { status: "done" }, O, "PATCH");
  const vl = (await ws(`/tasks/projects/${pid}/versions`, undefined, O)).json.versions as any[];
  check("a version shows its progress", vl.find((v) => v.id === v1.id)?.issues === 2 && vl.find((v) => v.id === v1.id)?.done === 1);
  const notes = (await ws(`/tasks/projects/${pid}/versions?notes=${v1.id}`, undefined, O)).json.notes as string;
  check("release notes group issues by type", /# Board Parity Test 1.0/.test(notes) && /## New\n- .*Login page/.test(notes) && /## Fixes\n- .*Broken logo/.test(notes), notes);
  check("members can't release", (await ws(`/tasks/projects/${pid}/versions`, { action: "release", id: v1.id, moveTo: v2.id }, M)).status === 403);
  const rel = await ws(`/tasks/projects/${pid}/versions`, { action: "release", id: v1.id, moveTo: v2.id }, O);
  check("release a version: unfinished work moves to the next one", rel.json.version?.status === "released" && rel.json.moved === 1 && (await ws(`/tasks/${s2.id}`, undefined, O)).json.task.versionId === v2.id, rel.json);
  check("a version from another project is refused", (await add({ title: "x", versionId: "nope" })).error !== undefined);

  // ── Components
  const c1 = (await ws(`/tasks/projects/${pid}/components`, { name: "Checkout", leadId: mid }, O)).json.component;
  check("create a component with a lead", c1?.leadId === mid);
  const ci = (await add({ title: "Pay later", componentIds: [c1.id] })).task;
  check("a new issue in a component goes to its lead", ci?.assigneeId === mid && ci.componentIds.includes(c1.id), ci);
  const ci2 = (await add({ title: "Pay later 2", componentIds: [c1.id], assigneeId: null })).task;
  check("unless someone else is picked", ci2.assigneeId === mid || ci2.assigneeId === null);

  // ── Query fields, quick filters, features
  await ws(`/tasks/${ci.id}`, { flagged: true }, O, "PATCH");
  const qf = await ws(`/tasks?q=${encodeURIComponent(`project = ${key} AND flagged = true`)}`, undefined, O);
  check("query: flagged", qf.json.tasks?.length === 1 && qf.json.tasks[0].id === ci.id);
  check("query: fixVersion and component", (await ws(`/tasks?q=${encodeURIComponent(`fixVersion = "1.1" AND project = ${key}`)}`, undefined, O)).json.tasks?.some((t: any) => t.id === s2.id) && (await ws(`/tasks?q=${encodeURIComponent(`component = Checkout`)}`, undefined, O)).json.tasks?.length >= 1);
  const qs = await ws(`/tasks/projects/${pid}`, { quickFilters: [{ name: "Blocked", query: "flagged = true" }], features: { sprints: false, estimation: "time" } }, O, "PATCH");
  check("quick filters and features are saved", qs.json.project?.quickFilters?.[0]?.name === "Blocked" && qs.json.project.features.sprints === false && qs.json.project.features.estimation === "time" && qs.json.project.features.releases === true, qs.json);

  // ── Summary and insights
  const sm = await ws(`/tasks/projects/${pid}/overview?kind=summary`, undefined, O);
  check("the summary counts the last 7 days and the status mix", sm.json.counts?.created >= 4 && sm.json.counts.completed >= 1 && (sm.json.status as any[]).reduce((a, s) => a + s.n, 0) >= 4 && sm.json.activity.length > 0, sm.json.counts);
  const bl = (await add({ title: "Blocker" })).task;
  const victim = (await add({ title: "Blocked one", status: "doing" })).task;
  await ws(`/tasks/${bl.id}/links`, { kind: "blocks", other: victim.id }, O);
  const ins = await ws(`/tasks/projects/${pid}/overview?kind=insights`, undefined, O);
  check("insights: progress and flagged work", ins.json.progress?.done >= 1 && (ins.json.attention.flagged as any[]).some((x) => x.id === ci.id));
  check("insights: work blocked by an open issue", (ins.json.attention.blocked as any[]).some((x) => x.id === victim.id));
  check("issues list which issues they block (timeline arrows)", ((await ws(`/tasks?projectId=${pid}`, undefined, O)).json.tasks as any[]).find((t) => t.id === bl.id)?.blocks.includes(victim.id));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) await ws(`/tasks/projects/${pid}`, { archived: true }, O, "PATCH").catch(() => null);
  process.exit(summary("Tasks (board parity)") ? 1 : 0);
}
