/**
 * Automations end to end on a real project in Ask mode (free chat allowance,
 * so no credits): validation, run now with its result recorded, pause and
 * resume, a one-off that fires from the scheduler, delete. Real agent turns.
 *   npx tsx scripts/test-automations.mts <devToken> <projectId>
 */
const BASE = "http://localhost:3000";
const [token, pid] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function call(path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method: json === undefined ? "GET" : "POST",
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const A = "/api/automations";
const list = async () => (await call(A)).body.automations as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitBuild(buildId: string) {
  for (let i = 0; i < 60; i++) {
    const msgs = (await call(`/api/projects/${pid}/messages`)).body.messages as any[];
    const m = msgs.find((x) => x.build?.id === buildId);
    if (m && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(m.build.status)) return m;
    await sleep(5000);
  }
  return null;
}

async function main() {
  const base = { action: "create", projectId: pid, name: "Test report", prompt: "How many files are in src/? Answer in one short sentence.", mode: "ask", timezone: "Asia/Kolkata" };
  check("bad cron refused", (await call(A, { ...base, schedule: "99 * * * *" })).status === 400);
  check("bad time zone refused", (await call(A, { ...base, schedule: "0 9 * * *", timezone: "Mars/Base" })).status === 400);
  check("past one-off refused", (await call(A, { ...base, schedule: "once:2020-01-01T00:00:00Z" })).status === 400);
  check("never-running schedule refused", (await call(A, { ...base, schedule: "0 0 30 2 *" })).status === 400);

  const created = await call(A, { ...base, schedule: "0 9 * * 1-5" });
  check("create weekday automation", created.status === 201 && !!created.body.nextRunAt);
  const id = created.body.id;
  let a = (await list()).find((x) => x.id === id);
  check("schedule described", a.scheduleText === "Weekdays at 09:00", a.scheduleText);
  check("next run is 09:00 Kolkata (03:30 UTC)", new Date(a.nextRunAt).toISOString().endsWith("03:30:00.000Z"), a.nextRunAt);

  const before = (await call("/api/workspace/allowance")).body.freeChatsLeft;
  const credits0 = (await call("/api/workspace/billing")).body.balance;
  const run = await call(A, { action: "run", id });
  check("run now queues a turn", run.status === 200 && !!run.body.buildId);
  const msg = await waitBuild(run.body.buildId);
  check("run finished", msg?.build?.status === "SUCCEEDED", msg?.build?.status);
  await call(A, { action: "tick" });
  a = (await list()).find((x) => x.id === id);
  check("result recorded", !!a.lastResult && a.runs === 1, a.lastResult);
  check("manual run kept the schedule", new Date(a.nextRunAt).toISOString().endsWith("03:30:00.000Z"));
  const after = (await call("/api/workspace/allowance")).body.freeChatsLeft;
  const credits1 = (await call("/api/workspace/billing")).body.balance;
  check("ask run used the free allowance", after === before - 1 && credits1 === credits0, `allowance ${before}->${after}, credits ${credits0}->${credits1}`);

  await call(A, { action: "pause", id });
  a = (await list()).find((x) => x.id === id);
  check("pause", a.status === "paused" && a.pausedReason === "manual" && !a.nextRunAt);
  await call(A, { action: "resume", id });
  a = (await list()).find((x) => x.id === id);
  check("resume", a.status === "active" && !!a.nextRunAt);
  await call(A, { action: "delete", id });
  check("delete", !(await list()).some((x) => x.id === id));

  // A one-off due in ~65s, fired by the scheduler tick (as the background loop would).
  const at = new Date(Date.now() + 65_000).toISOString();
  const once = await call(A, { ...base, name: "One-off", schedule: `once:${at}` });
  check("create one-off", once.status === 201);
  await sleep(70_000);
  await call(A, { action: "tick" });
  const o = (await list()).find((x) => x.id === once.body.id);
  check("one-off fired and finished", o?.runs === 1 && o.status === "done" && !o.nextRunAt, JSON.stringify({ runs: o?.runs, status: o?.status }));
  if (o?.lastBuildId) await waitBuild(o.lastBuildId);
  await call(A, { action: "tick" });
  await call(A, { action: "delete", id: once.body.id });

  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
