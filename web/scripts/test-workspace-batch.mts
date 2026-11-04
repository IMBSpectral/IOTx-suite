/**
 * Skills, project notes, environment variables, assistant prompts and the
 * findings count, over the API. One real agent turn checks that /skill runs
 * the skill. Throwaway project and skill, removed at the end.
 *   npx tsx scripts/test-workspace-batch.mts <devToken>
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import "dotenv/config";
import { PROJECTS_ROOT } from "../src/lib/paths";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(path: string, json?: unknown, method?: string) {
  const res = await fetch(BASE + path, {
    method: method ?? (json === undefined ? "GET" : "POST"),
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }
  return { status: res.status, body };
}

let pid = "";
let skillId = "";

async function main() {
  // ── Skills ───────────────────────────────────────────────────
  const S = "/api/workspace/skills";
  const instructions = "Add a one-line comment at the very top of src/App.tsx that says: // Reviewed by the test skill";
  check("bad name refused", (await call(S, { action: "save", name: "Bad Name!", instructions })).status === 400);
  check("built-in command refused", (await call(S, { action: "save", name: "plan", instructions })).status === 400);
  check("empty instructions refused", (await call(S, { action: "save", name: "test-skill", instructions: "hi" })).status === 400);
  const made = await call(S, { action: "save", name: "test-skill", title: "Test skill", description: "For the test", instructions });
  skillId = made.body.skill?.id;
  check("skill saved", made.status === 200 && !!skillId);
  check("duplicate name refused", (await call(S, { action: "save", name: "test-skill", instructions })).status === 400);
  check("skill listed", (await call(S)).body.skills.some((s: any) => s.id === skillId));
  const edited = await call(S, { action: "save", id: skillId, name: "test-skill", title: "Test skill v2", instructions });
  check("skill edited", edited.body.skill?.title === "Test skill v2");

  // ── Env vars at creation ────────────────────────────────────
  check("bad variable name refused", (await call("/api/projects", { name: "Env bad", force: true, env: [{ name: "1BAD", value: "x" }] })).status === 400);
  const created = await call("/api/projects", {
    name: "Workspace batch test",
    force: true,
    env: [
      { name: "vite_greeting", value: "hello world" },
      { name: "SECRET_TOKEN", value: "s3cr3t" },
    ],
  });
  pid = created.body.project?.id;
  check("project created with variables", created.status === 201 && !!pid);
  const P = `/api/projects/${pid}`;
  check("names listed, values not", JSON.stringify((await call(`${P}/env`)).body) === JSON.stringify({ names: ["VITE_GREETING", "SECRET_TOKEN"] }));
  const repo = `${PROJECTS_ROOT}/${pid}`;
  const envFile = fs.readFileSync(`${repo}/.env`, "utf8");
  check(".env written with quoting", envFile.includes('VITE_GREETING="hello world"') && envFile.includes("SECRET_TOKEN=s3cr3t"));
  const tracked = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8" });
  check(".env never committed", !tracked.split("\n").includes(".env"));
  await call(`${P}/env`, { set: [{ name: "EXTRA", value: "1" }], remove: ["SECRET_TOKEN"] }, "PUT");
  check("update merges and removes", JSON.stringify((await call(`${P}/env`)).body.names) === JSON.stringify(["VITE_GREETING", "EXTRA"]));
  check("kept value survives an update", fs.readFileSync(`${repo}/.env`, "utf8").includes('VITE_GREETING="hello world"'));

  // ── Notes ────────────────────────────────────────────────────
  check("notes start empty", (await call(`${P}/notes`)).body.text === "");
  check("notes must be text", (await call(`${P}/notes`, { text: 42 }, "PUT")).status === 400);
  check("notes have a size limit", (await call(`${P}/notes`, { text: "x".repeat(100_001) }, "PUT")).status === 400);
  await call(`${P}/notes`, { text: "# Plan\n- launch on Friday" }, "PUT");
  check("notes saved", (await call(`${P}/notes`)).body.text === "# Plan\n- launch on Friday");

  // ── Assistant prompt from a dashboard suggestion ─────────────
  const page = await call(`/assistant?prompt=${encodeURIComponent("Plan my launch please")}`);
  check("assistant opens with the prompt", page.body.text?.includes("Plan my launch please"));

  // ── Findings count on cards ──────────────────────────────────
  const list = (await call("/api/projects?view=all")).body.projects as any[];
  check("cards carry an open findings count", list.every((p) => typeof p.openFindings === "number"));

  // ── A real turn with /test-skill ─────────────────────────────
  const sent = await call(`${P}/messages`, { content: "/test-skill keep it short", mode: "build" });
  check("skill message sent", [200, 201, 202].includes(sent.status), `${sent.status}`);
  let reply: any = null;
  for (let i = 0; i < 60; i++) {
    const msgs = (await call(`${P}/messages`)).body.messages as any[];
    reply = msgs.filter((m) => m.role === "ASSISTANT").pop();
    if (reply?.build && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(reply.build.status)) break;
    await sleep(5000);
  }
  check("turn finished", reply?.build?.status === "SUCCEEDED", reply?.build?.status);
  check("skill step shown", (reply?.steps ?? []).includes("logs:Using skill /test-skill"), JSON.stringify(reply?.steps ?? []).slice(0, 200));
  const app = (await call(`${P}/files?path=src/App.tsx`)).body.content as string;
  check("skill instructions followed", /Reviewed by the test skill/.test(app ?? ""));
}

main()
  .catch((e) => {
    console.log("FAIL crashed —", e);
    failures++;
  })
  .finally(async () => {
    if (skillId) await call("/api/workspace/skills", { action: "delete", id: skillId });
    if (pid) await call(`/api/projects/${pid}?permanent=1`, undefined, "DELETE");
    console.log(failures ? `\n${failures} failed` : "\nAll passed");
    process.exit(failures ? 1 : 0);
  });
