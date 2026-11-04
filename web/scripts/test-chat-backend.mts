/**
 * Exercises the chat backend through its real HTTP routes, without spending
 * model tokens: undo/redo (including a file the edit added), bookmarks, queue
 * reorder/remove/pause, and stopping a queued turn before it starts.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { db } from "../src/lib/db";
import { repoDir } from "../src/lib/paths";
import { checkoutDraft } from "../src/lib/drafts";

const BASE = "http://localhost:3000";
const COOKIE = "authjs.session-token=839ad638-6bc1-4e43-a833-2b2bbc7cd74c";
const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2"; // throwaway smoke-test project
const AUTHOR = { name: "Builder", email: "builder@localhost" };

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { cookie: COOKIE, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  // Cleanup removes only what this run created, never the project's real chat.
  const started = new Date();
  const dir = repoDir(PID);
  // A name no earlier run can have committed, so the parent cannot contain it.
  const ADDED = `src/Added${Date.now()}.tsx`;
  await checkoutDraft(PID, null);

  // --- undo / redo, where the edit both changes a file and adds one --------
  const before = await fs.readFile(path.join(dir, "src/App.tsx"), "utf8");
  await fs.writeFile(path.join(dir, "src/App.tsx"), before + "\n// edited\n");
  await fs.writeFile(path.join(dir, ADDED), "export const Added = 1;\n");
  await git.add({ fs, dir, filepath: "src/App.tsx" });
  await git.add({ fs, dir, filepath: ADDED });
  const sha = await git.commit({ fs, dir, message: "test edit", author: AUTHOR });
  const msg = await db.message.create({ data: { projectId: PID, role: "ASSISTANT", content: "test" } });
  const build = await db.build.create({
    data: { projectId: PID, messageId: msg.id, status: "SUCCEEDED", sha },
  });

  const u = await api("POST", `/api/projects/${PID}/undo`, { buildId: build.id, action: "undo" });
  const afterUndo = await fs.readFile(path.join(dir, "src/App.tsx"), "utf8");
  const addedGone = !(await fs.stat(path.join(dir, ADDED)).catch(() => null));
  check("undo restores edited file", u.status === 200 && afterUndo === before, `HTTP ${u.status}`);
  check("undo removes the file the edit added", addedGone);

  const r = await api("POST", `/api/projects/${PID}/undo`, { buildId: build.id, action: "redo" });
  const afterRedo = await fs.readFile(path.join(dir, "src/App.tsx"), "utf8");
  const addedBack = !!(await fs.stat(path.join(dir, ADDED)).catch(() => null));
  check("redo reapplies the edit", r.status === 200 && afterRedo.includes("// edited") && addedBack);

  const older = await api("POST", `/api/projects/${PID}/undo`, { buildId: build.id, action: "undo" });
  check("undo of a non-latest edit is refused", older.status === 409, older.json?.error ?? "");

  // --- bookmarks ------------------------------------------------------------
  const b = await api("POST", `/api/projects/${PID}/bookmarks`, { name: "Before launch" });
  const list = await api("GET", `/api/projects/${PID}/bookmarks`);
  check("bookmark created at HEAD", !!b.json?.bookmark?.sha && list.json?.bookmarks?.length >= 1);
  await api("DELETE", `/api/projects/${PID}/bookmarks?bookmarkId=${b.json.bookmark.id}`);

  // --- queue: reorder, remove, stop-before-start, pause ---------------------
  await api("POST", `/api/projects/${PID}/queue`, { action: "pause" });
  const queued: string[] = [];
  for (const text of ["first", "second", "third"]) {
    const res = await api("POST", `/api/projects/${PID}/messages`, { content: `queue test ${text}`, mode: "ask" });
    queued.push(res.json.buildId as string);
  }
  await api("POST", `/api/projects/${PID}/queue`, {
    action: "reorder",
    order: [queued[2], queued[0], queued[1]],
  });
  const q = await api("GET", `/api/projects/${PID}/queue`);
  check(
    "reorder changes run order",
    q.json?.builds?.[0]?.id === queued[2] && q.json?.paused === true,
    `order: ${q.json?.builds?.map((x: { id: string }) => queued.indexOf(x.id) + 1).join(",")}`,
  );

  const rm = await api("POST", `/api/builds/${queued[1]}`, { action: "remove" });
  const gone = await db.build.findUnique({ where: { id: queued[1] } });
  check("remove deletes a queued message", rm.status === 200 && !gone);

  for (const id of [queued[0], queued[2]]) await api("POST", `/api/builds/${id}`, { action: "stop" });
  await api("POST", `/api/projects/${PID}/queue`, { action: "resume" });
  // The worker claims stopped builds and cancels them without calling the model.
  let states: string[] = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    states = (await db.build.findMany({ where: { id: { in: [queued[0], queued[2]] } } })).map((x) => x.status);
    if (states.every((s) => s === "CANCELLED")) break;
  }
  check("stopped queued turns are cancelled without running", states.every((s) => s === "CANCELLED"), states.join(","));
  const spent = await db.build.findMany({ where: { id: { in: [queued[0], queued[2]] } } });
  check("cancelled turns spent no tokens", spent.every((x) => x.inputTokens === 0));

  // --- cleanup --------------------------------------------------------------
  await db.build.deleteMany({ where: { projectId: PID, id: { in: [build.id, ...queued] } } });
  await db.message.deleteMany({ where: { projectId: PID, createdAt: { gte: started } } });
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("THREW:", e);
  await db.$disconnect();
  process.exit(1);
});
