/**
 * Viewing past versions from History: a version link on its own host, the
 * "rebuild it" page when the build isn't there, the rebuild itself, the app
 * served with its router at "/", validation, outsiders refused, and the
 * working tree put back after a rebuild. Needs Docker (builds run in the
 * project's sandbox). Uses a throwaway project, deleted at the end.
 *   npx tsx scripts/test-versions.mts <devToken> <usersJson>
 */
import fs from "node:fs";
import http from "node:http";

function hostReq(host: string, path: string, opts: { method?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: 3000, path, method: opts.method ?? "GET", headers: { host } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    r.on("error", reject);
    r.end();
  });
}

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const outsider = JSON.parse(fs.readFileSync(usersPath, "utf8"))["outsider@localhost"];
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function call(path: string, json?: unknown, method?: string, who = token) {
  const res = await fetch(BASE + path, {
    method: method ?? (json === undefined ? "GET" : "POST"),
    headers: { cookie: `authjs.session-token=${who}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

let pid = "";

async function main() {
  pid = (await call("/api/projects", { name: "Versions test", force: true })).body.project.id;
  const P = `/api/projects/${pid}`;
  // A second version, so the first one is "the past".
  await call(`${P}/files`, { path: "src/version.txt", content: "two" }, "PUT");
  const commits = (await call(`${P}/history`)).body.commits as { sha: string; message: string }[];
  check("history has two versions", commits.length >= 2, `${commits.length}`);
  const old = commits[commits.length - 1].sha;

  check("bad sha refused", (await call(`${P}/versions`, { sha: "nope" })).status === 400);
  check("unknown sha refused", (await call(`${P}/versions`, { sha: "0".repeat(40) })).status === 404);
  check("outsider refused", [403, 404].includes((await call(`${P}/versions`, { sha: old }, undefined, outsider)).status));

  const v = await call(`${P}/versions`, { sha: old });
  check("version link created", v.status === 200 && /^http:\/\/version--[a-z0-9]{16}\./.test(v.body.url), v.body.url);
  check("not built yet", v.body.built === false);
  const host = new URL(v.body.url).host;

  const missing = await hostReq(host, "/");
  check("pruned page offers a rebuild", missing.status === 404 && missing.text.includes("Older previews are cleaned up") && missing.text.includes("Rebuild"));
  check("expired or fake link refused", (await hostReq("version--aaaaaaaaaaaaaaaa.localhost:3000", "/")).status === 410);

  const t0 = Date.now();
  const rebuilt = await hostReq(host, "/__forge/rebuild", { method: "POST" });
  check("rebuild redirects to the version", rebuilt.status === 303 && rebuilt.headers.location === "/", `${rebuilt.status} in ${Math.round((Date.now() - t0) / 1000)}s ${rebuilt.text.slice(0, 200)}`);
  const page = await hostReq(host, "/");
  check("version is served", page.status === 200 && page.text.includes('<div id="root">') && page.text.includes("noindex"));
  const deep = await hostReq(host, "/some/route");
  check("deep links fall back to the app", deep.status === 200 && deep.text.includes('<div id="root">'));
  const asset = page.text.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  check("assets load", !!asset && (await hostReq(host, asset!)).status === 200, asset);
  check("missing asset is a 404", (await hostReq(host, "/assets/nope.js")).status === 404);
  check("now reported as built", (await call(`${P}/versions`, { sha: old })).body.built === true);

  // The rebuild checked out the old version; the project must be back on its latest.
  const file = await call(`${P}/files?path=src/version.txt`);
  check("working tree restored", file.body.content === "two");
}

main()
  .catch((e) => {
    console.log("FAIL crashed —", e);
    failures++;
  })
  .finally(async () => {
    if (pid) await call(`/api/projects/${pid}?permanent=1`, undefined, "DELETE");
    console.log(failures ? `\n${failures} failed` : "\nAll passed");
    process.exit(failures ? 1 : 0);
  });
