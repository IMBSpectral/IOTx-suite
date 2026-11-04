/**
 * Monitoring over HTTP on a published project: a full health run, SEO
 * review, ignore/undo, configure, and Fix with dedupe. The project's queue is
 * paused around Fix so no agent turn (and no credit spend) actually runs.
 *   npx tsx scripts/test-monitoring.mts <devToken> <projectId>
 */
const BASE = "http://localhost:3000";
const [token, pid] = process.argv.slice(2);
const M = `/api/projects/${pid}/monitoring`;
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

async function main() {
  const before = (await call(M)).body;
  check("monitoring state readable", typeof before.on === "boolean");

  const t0 = Date.now();
  const run = await call(M, { action: "run" });
  check("health run completes", run.status === 200 && Array.isArray(run.body.run.findings), `${((Date.now() - t0) / 1000).toFixed(0)}s, error=${run.body.run?.error ?? "none"}`);
  const findings = run.body.run.findings as { key: string; category: string; severity: string; title: string }[];
  console.log("  findings:", findings.map((f) => `${f.category}/${f.severity}: ${f.title}`).join(" | ") || "none");
  check("no uptime problem on a live site", !findings.some((f) => f.key === "uptime.down"));

  const seo = await call(M, { action: "seo" });
  check("SEO review runs", seo.status === 200 && seo.body.run.trigger === "seo");

  // Use the full run's findings for ignore/fix: rerun so it is latest.
  await call(M, { action: "run" });
  const state = (await call(M)).body;
  check("history recorded", state.history.length >= 3, `${state.history.length} runs`);
  const first = state.open[0];
  if (first) {
    await call(M, { action: "ignore", key: first.key });
    let s = (await call(M)).body;
    check("ignore hides from brief", !s.open.some((f: any) => f.key === first.key) && s.ignored.includes(first.key));
    await call(M, { action: "unignore", key: first.key });
    s = (await call(M)).body;
    check("undo ignore restores", s.open.some((f: any) => f.key === first.key));

    await call(`/api/projects/${pid}/queue`, { action: "pause" });
    const fix = await call(M, { action: "fix", keys: [first.key] });
    check("fix queues a build", fix.status === 200 && !!fix.body.buildId);
    const again = await call(M, { action: "fix", keys: [first.key] });
    check("second fix deduped", again.status === 409 && /already being fixed/.test(again.body.error));
    s = (await call(M)).body;
    check("fixing state exposed", s.fixing.includes(first.key));
    const rm = await call(`/api/builds/${fix.body.buildId}`, { action: "remove" });
    check("queued fix removed", rm.status === 200, JSON.stringify(rm.body).slice(0, 100));
    await call(`/api/projects/${pid}/queue`, { action: "resume" });
  } else {
    console.log("  (no open findings, skipping ignore/fix checks)");
  }
  check("fix with nothing refused", (await call(M, { action: "fix", keys: ["nope"] })).status === 400);

  await call(M, { action: "configure", on: true, frequency: "weekly" });
  let s = (await call(M)).body;
  check("configure on + weekly", s.on === true && s.frequency === "weekly");
  await call(M, { action: "configure", on: before.on, frequency: before.frequency });
  s = (await call(M)).body;
  check("configure restored", s.on === before.on);

  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
