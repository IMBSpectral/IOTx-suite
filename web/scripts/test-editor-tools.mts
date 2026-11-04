/**
 * Editor power tools: the terminal (streamed output, working directory that
 * carries over, exit codes, Ctrl+C), visual explanations (stored, served
 * sandboxed, refused when empty), and the installable-app files. Throwaway
 * project, deleted at the end.
 *   npx tsx scripts/test-editor-tools.mts <devToken>
 */
import { createVisual } from "../src/lib/visuals";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Run a terminal command; returns the printed output and the exit event. */
async function term(pid: string, command: string, cwd = "/app", abortAfterMs?: number) {
  const ctl = new AbortController();
  if (abortAfterMs) setTimeout(() => ctl.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/projects/${pid}/terminal`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command, cwd }),
      signal: ctl.signal,
    });
  } catch {
    return { status: 0, out: "", exit: null as null | { code: number; cwd: string } };
  }
  if (!res.ok || !res.body) return { status: res.status, out: "", exit: null as null | { code: number; cwd: string } };
  let out = "";
  let exit: { code: number; cwd: string } | null = null;
  try {
    const text = await res.text();
    for (const p of text.split("\n\n")) {
      if (!p.startsWith("data: ")) continue;
      const ev = JSON.parse(p.slice(6));
      if (ev.type === "out") out += ev.data;
      if (ev.type === "exit") exit = { code: ev.code, cwd: ev.cwd };
    }
  } catch {
    // aborted
  }
  return { status: res.status, out, exit };
}

let pid = "";
try {
  const created = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Editor tools test", force: true }),
  });
  pid = ((await created.json()) as { project: { id: string } }).project.id;
  check("project created", !!pid);

  // Terminal
  const empty = await term(pid, "   ");
  check("empty command refused", empty.status === 400);
  const unauth = await fetch(`${BASE}/api/projects/${pid}/terminal`, { method: "POST", body: "{}" });
  check("signed-out terminal refused", unauth.status === 401 || unauth.status === 403, String(unauth.status));

  const ls = await term(pid, "pwd && ls");
  check("terminal runs in the container", ls.status === 200 && ls.out.includes("/app"), ls.out.slice(0, 120));
  check("project files listed", /package\.json/.test(ls.out));
  check("exit 0 reported", ls.exit?.code === 0);
  check("cwd marker hidden from output", !ls.out.includes("__FORGE_CWD__"));

  const cd = await term(pid, "mkdir -p /tmp/forge-term && cd /tmp/forge-term");
  check("cd carries over", cd.exit?.cwd === "/tmp/forge-term", cd.exit?.cwd);
  const there = await term(pid, "pwd", cd.exit?.cwd);
  check("next command starts there", there.out.trim() === "/tmp/forge-term", there.out.trim());

  const fail = await term(pid, "ls /definitely-missing");
  check("failing command reports its exit code", (fail.exit?.code ?? 0) !== 0 && /No such file/.test(fail.out), String(fail.exit?.code));

  const started = Date.now();
  await term(pid, "sleep 30", "/app", 1500);
  check("Ctrl+C stops a running command", Date.now() - started < 10_000);
  const after = await term(pid, "echo still-here");
  check("terminal still works after Ctrl+C", after.out.includes("still-here"));
  const ps = await term(pid, "ps -ef | grep -c '[s]leep 30' || true");
  check("Ctrl+C killed the command in the container", ps.out.trim() === "0", ps.out.trim());

  // Visual explanations
  const v = await createVisual(pid, "Request flow", `<svg viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="40" x="5" y="10" fill="#6d4aff"/><text x="10" y="35">Client</text></svg>`);
  check("visual stored as svg", v.kind === "svg");
  const page = await fetch(`${BASE}/api/projects/${pid}/visuals/${v.id}?theme=dark`, { headers: { cookie } });
  const html = await page.text();
  check("visual served", page.status === 200 && html.includes("<svg") && html.includes("#17171a"));
  check("visual sandboxed with no network", /sandbox allow-scripts; default-src 'none'/.test(page.headers.get("content-security-policy") ?? ""));
  const anon = await fetch(`${BASE}/api/projects/${pid}/visuals/${v.id}`);
  check("visual needs access", anon.status === 401 || anon.status === 403 || anon.status === 404, String(anon.status));
  const bad = await fetch(`${BASE}/api/projects/${pid}/visuals/not-an-id`, { headers: { cookie } });
  check("unknown visual is 404", bad.status === 404);
  let refused = false;
  try {
    await createVisual(pid, "x", "just words");
  } catch {
    refused = true;
  }
  check("plain text refused as a visual", refused);

  // Installable app
  const mf = await fetch(`${BASE}/manifest.webmanifest`);
  const manifest = (await mf.json()) as { display?: string; icons?: unknown[]; start_url?: string };
  check("web manifest", mf.status === 200 && manifest.display === "standalone" && !!manifest.icons?.length);
  const sw = await fetch(`${BASE}/sw.js`);
  check("service worker served", sw.status === 200 && (await sw.text()).includes("fetch"));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) {
    const del = await fetch(`${BASE}/api/projects/${pid}`, { method: "DELETE", headers: { cookie } });
    check("project deleted", del.ok, String(del.status));
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
