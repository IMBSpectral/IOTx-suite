/** Security center over HTTP: scan, ignore with reason, toggle, export, free fix. */
const BASE = "http://localhost:3000";
const COOKIE = "authjs.session-token=839ad638-6bc1-4e43-a833-2b2bbc7cd74c";
const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2";

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { cookie: COOKIE, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  // Two planted issues in a file of their own.
  await api("PUT", `/api/projects/${PID}/files`, {
    path: "src/unsafe.ts",
    content:
      "export function render(el: HTMLElement, html: string) {\n  el.innerHTML = html;\n}\n" +
      "export const newToken = () => Math.random().toString(36) + 'token';\n",
  });

  const scan = await api("POST", `/api/projects/${PID}/security`, { action: "scan" });
  check("scan runs", scan.status === 200, `${scan.json?.findings} findings, ${scan.json?.audit?.packages?.length ?? "?"} vulnerable packages`);

  let data = (await api("GET", `/api/projects/${PID}/security`)).json;
  const xss = data.findings.find((f: any) => f.rule === "xss.dom-innerhtml" && f.file === "src/unsafe.ts");
  const rnd = data.findings.find((f: any) => f.rule === "crypto.weak-random" && f.file === "src/unsafe.ts");
  check("finds innerHTML", !!xss, xss ? `${xss.title} at ${xss.file}:${xss.line}` : "");
  check("finds predictable token", !!rnd);
  check("catalog has 32 checks with plain-language fields", data.checks.length === 32 && !!data.checks[0].passesWhen);

  const noReason = await api("POST", `/api/projects/${PID}/security`, { action: "ignore", findingId: rnd.id, reason: "" });
  check("ignoring requires a reason", noReason.status === 400);
  await api("POST", `/api/projects/${PID}/security`, { action: "ignore", findingId: rnd.id, reason: "Only used for UI keys" });
  await api("POST", `/api/projects/${PID}/security`, { action: "scan" });
  data = (await api("GET", `/api/projects/${PID}/security`)).json;
  const stillIgnored = data.findings.find((f: any) => f.rule === "crypto.weak-random" && f.file === "src/unsafe.ts");
  check("ignored finding stays ignored after a rescan", stillIgnored?.ignored === true && stillIgnored?.ignoreReason === "Only used for UI keys");

  await api("POST", `/api/projects/${PID}/security`, { action: "toggle", checkId: "xss.dom-innerhtml", enabled: false });
  await api("POST", `/api/projects/${PID}/security`, { action: "scan" });
  data = (await api("GET", `/api/projects/${PID}/security`)).json;
  check("a disabled check stops reporting", !data.findings.some((f: any) => f.rule === "xss.dom-innerhtml"));
  await api("POST", `/api/projects/${PID}/security`, { action: "toggle", checkId: "xss.dom-innerhtml", enabled: true });
  await api("POST", `/api/projects/${PID}/security`, { action: "scan" });
  data = (await api("GET", `/api/projects/${PID}/security`)).json;

  const csv = await api("GET", `/api/projects/${PID}/security/dependencies?format=csv`);
  check("dependency export (CSV)", csv.status === 200 && csv.text.startsWith("package,severity"), `${csv.text.split("\n").length - 2} rows`);

  const forged = await api("POST", `/api/projects/${PID}/security`, { action: "fix", findingIds: ["not-a-finding"] });
  check("free fix refuses ids that aren't open findings", forged.status === 400);

  const target = data.findings.find((f: any) => f.rule === "xss.dom-innerhtml" && !f.ignored);
  const fix = await api("POST", `/api/projects/${PID}/security`, { action: "fix", findingIds: [target.id] });
  check("free fix queued", fix.status === 200 && !!fix.json?.buildId);

  // Leave the project as we found it: a finished fix would open a draft that
  // keeps src/unsafe.ts fixed, and the next run could no longer plant it.
  if (fix.json?.buildId) {
    await api("POST", `/api/builds/${fix.json.buildId}`, { action: "stop" });
    for (let i = 0; i < 30; i++) {
      const drafts = (await api("GET", `/api/projects/${PID}/drafts`)).json?.drafts ?? [];
      const mine = drafts.filter((d: any) => new Date(d.createdAt).getTime() >= started);
      for (const d of mine) await api("POST", `/api/projects/${PID}/drafts/${d.id}`, { action: "discard" });
      const q = (await api("GET", `/api/projects/${PID}/queue`)).json;
      if (!q?.builds?.length) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
const started = Date.now();
main().catch((e) => {
  console.error("THREW:", e);
  process.exit(1);
});
