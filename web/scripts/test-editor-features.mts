/**
 * Live checks for features built this batch that don't need the model:
 * code-editor save, project icon, bookmarks rename, soft delete and restore.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { repoDir } from "../src/lib/paths";

const BASE = "http://localhost:3000";
const COOKIE = "authjs.session-token=839ad638-6bc1-4e43-a833-2b2bbc7cd74c";
const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2";

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
  // Code editor save → file on disk + a commit in history
  const marker = `// saved from the code editor ${Date.now()}`;
  const file = "src/App.tsx";
  const before = (await api("GET", `/api/projects/${PID}/files?path=${file}`)).json.content as string;
  const save = await api("PUT", `/api/projects/${PID}/files`, { path: file, content: `${before}\n${marker}\n` });
  const disk = await fs.readFile(path.join(repoDir(PID), file), "utf8");
  const hist = await api("GET", `/api/projects/${PID}/history`);
  check("code editor save writes the file", save.status === 200 && disk.includes(marker), `HTTP ${save.status}`);
  check("code editor save is a commit in history", hist.json?.commits?.[0]?.message === `Edit ${file}`);
  const bad = await api("PUT", `/api/projects/${PID}/files`, { path: "../../etc/passwd", content: "x" });
  check("code editor refuses paths outside the project", bad.status === 400);
  await api("PUT", `/api/projects/${PID}/files`, { path: file, content: before });

  // Project icon
  const e = await api("PATCH", `/api/projects/${PID}`, { emoji: "🚀" });
  const stored = await db.project.findUnique({ where: { id: PID }, select: { emoji: true } });
  check("project icon saved", e.status === 200 && stored?.emoji === "🚀");
  const tooLong = await api("PATCH", `/api/projects/${PID}`, { emoji: "this is not an emoji" });
  check("project icon rejects text", tooLong.status === 400);

  // Bookmark rename
  const b = await api("POST", `/api/projects/${PID}/bookmarks`, { name: "First" });
  await api("PATCH", `/api/projects/${PID}/bookmarks`, { bookmarkId: b.json.bookmark.id, name: "Renamed" });
  const list = await api("GET", `/api/projects/${PID}/bookmarks`);
  check("bookmark rename", list.json.bookmarks.some((x: { name: string }) => x.name === "Renamed"));
  await api("DELETE", `/api/projects/${PID}/bookmarks?bookmarkId=${b.json.bookmark.id}`);

  // Soft delete then restore
  const del = await api("DELETE", `/api/projects/${PID}`);
  const deleted = await db.project.findUnique({ where: { id: PID }, select: { deletedAt: true } });
  check("delete is soft (restorable)", del.json?.permanent === false && !!deleted?.deletedAt);
  const restore = await api("PATCH", `/api/projects/${PID}`, { restore: true });
  const back = await db.project.findUnique({ where: { id: PID }, select: { deletedAt: true } });
  check("restore from recently deleted", restore.status === 200 && back?.deletedAt === null);

  await db.$disconnect();
}
main().catch(async (err) => {
  console.error("THREW:", err);
  await db.$disconnect();
  process.exit(1);
});
