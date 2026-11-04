/**
 * The dashboard "new project with files" flow, end to end with real files:
 * create the project, upload each file (as the composer now does), send the
 * prompt with the attachments, and wait for the build. Checks that the turn
 * starts with the person's prompt, that every file reaches the agent (Excel,
 * Word and big PDFs as text), and that the build finishes.
 *   npx tsx scripts/test-attachments-build.mts <devToken> <file> [file…]
 * Keeps the project (it's a real app to look at) and prints its link.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { attachmentBlocks, readUpload, type Attachment } from "../src/lib/uploads";

const [devToken, ...files] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const H = { cookie: `authjs.session-token=${devToken}` };
let fail = 0;
const check = (l: string, ok: boolean, x: unknown = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${l}${!ok && x ? `  ${JSON.stringify(x).slice(0, 500)}` : ""}`); };
const types: Record<string, string> = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", md: "text/markdown", html: "text/html" };

const prompt = "Supreme Steel makes RA shafts and steering arms. Using the attached cost sheets, control plan, photos and documents, build a production planning platform for them: parts with their cost breakdown, routing and control-plan checkpoints per operation, current WIP by operation and the bottlenecks, and a plan for upcoming orders. Go through the attachments and the knowledge base for context.";
const started = new Date();
const res = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ name: `Supreme Steel planning ${started.toISOString().slice(11, 16)}`, force: true, env: [] }) });
const { project } = (await res.json()) as any;
check("project created", res.ok && !!project?.id, project);
const ids: string[] = [];
for (const f of files) {
  const fd = new FormData();
  const ext = path.extname(f).slice(1).toLowerCase();
  fd.append("file", new Blob([new Uint8Array(fs.readFileSync(f))], { type: types[ext] ?? "application/octet-stream" }), path.basename(f));
  const t = Date.now();
  const up = await fetch(`${BASE}/api/projects/${project.id}/uploads`, { method: "POST", headers: H, body: fd });
  const j = (await up.json().catch(() => ({}))) as any;
  check(`uploaded ${path.basename(f)} (${Math.round(fs.statSync(f).size / 1024)} KB, ${Date.now() - t} ms)`, up.ok && !!j.attachments?.[0]?.id, j);
  if (j.attachments?.[0]?.id) ids.push(j.attachments[0].id);
}
// What the agent will get from these files.
const metas: Attachment[] = [];
for (const id of ids) {
  const u = await readUpload(project.id, id);
  if (u) metas.push(u.meta);
}
const { blocks, index } = await attachmentBlocks(project.id, metas);
const size = blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : b.source.data.length), 0);
console.log(`\nWhat the agent gets:\n${index}\n  ${blocks.length} blocks: ${blocks.filter((b) => b.type === "image").length} images, ${blocks.filter((b) => b.type === "document").length} PDFs whole, ${blocks.filter((b) => b.type === "text").length} as text; ${(size / 1024 / 1024).toFixed(1)} MB in all\n`);
check("the whole turn fits the API's request size", size < 28 * 1024 * 1024, size);
check("every file is read (none left as name only)", !/— (not read|couldn't|image not shown)/.test(index), index);
const m = await fetch(`${BASE}/api/projects/${project.id}/messages`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ content: prompt, attachmentIds: ids }) });
check("the prompt is sent with all the files", m.status < 300, await m.text().catch(() => ""));
let build: any = null;
const t0 = Date.now();
for (let i = 0; i < 300; i++) {
  build = await db.build.findFirst({ where: { projectId: project.id, createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
  if (build && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(build.status))) break;
  await new Promise((r) => setTimeout(r, 5000));
}
const user = await db.message.findFirst({ where: { projectId: project.id, role: "USER" }, orderBy: { createdAt: "asc" } });
check("the first message is the person's prompt, with every file", user?.content === prompt && (user?.attachments as any[])?.length === ids.length, { content: user?.content?.slice(0, 80), n: (user?.attachments as any[])?.length });
check(`the build finishes (${Math.round((Date.now() - t0) / 1000)} s)`, build?.status === "SUCCEEDED", { status: build?.status, error: build?.error });
const done = await db.buildEvent.findFirst({ where: { buildId: build?.id, payload: { path: ["type"], equals: "done" } } });
const written = ((done?.payload as any)?.files ?? []) as string[];
check(`the app was actually written (${written.length} files)`, written.length >= 3, done?.payload);
const reply = await db.message.findFirst({ where: { projectId: project.id, role: "ASSISTANT" }, orderBy: { createdAt: "desc" } });
console.log(`\nAgent's summary:\n${String(reply?.content ?? "").slice(0, 1500)}\n`);
console.log(`Open it: ${BASE}/projects/${project.id}`);
await db.$disconnect();
console.log(`\nAttachments build: ${fail ? `${fail} FAILED` : "all passed"}`);
process.exit(fail ? 1 : 0);
