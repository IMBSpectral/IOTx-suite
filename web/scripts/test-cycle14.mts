/**
 * Folder-controlled visibility (restricted folders, members, inheritance,
 * "View access"), hidden folders, element screenshots on comments, and the
 * dashboard's recent-assets strip.
 *   npx tsx scripts/test-cycle14.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import sharp from "sharp";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const projects: string[] = [];
const folders: string[] = [];
let wsId = "";

try {
  const owner = `authjs.session-token=${token}`;
  const mk = async (name: string) => {
    const id = ((await (await fetch(`${BASE}/api/projects`, { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify({ name, force: true }) })).json()) as { project: { id: string } }).project.id;
    projects.push(id);
    return id;
  };
  const p1 = await mk("Cycle 14 restricted");
  wsId = (await db.project.findUniqueOrThrow({ where: { id: p1 } })).workspaceId;
  const ownerC = `${owner}; forge_ws=${wsId}`;
  const memberToken = users["member@localhost"];
  const memberId = (await db.session.findUnique({ where: { sessionToken: memberToken }, select: { userId: true } }))?.userId ?? "";
  const membership = await db.membership.findFirst({ where: { userId: memberId, workspaceId: wsId } });
  if (!membership || membership.role === "OWNER" || membership.role === "ADMIN") throw new Error(`member@localhost must be a plain member of the dev workspace (is ${membership?.role ?? "not a member"})`);
  const memberC = `authjs.session-token=${memberToken}; forge_ws=${wsId}`;
  const api = async (path: string, c: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { cookie: c, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const folderIds = async (c: string) => ((await api("/api/folders", c)).json.folders as { id: string; hidden: boolean; restricted: boolean }[]) ?? [];
  const listIn = async (c: string, folder: string, view = "all") => (((await api(`/api/projects?view=${view}&folder=${folder}`, c)).json.projects as { id: string }[]) ?? []).map((p) => p.id);

  // ── Folder-controlled visibility ──
  const f = ((await api("/api/folders", ownerC, "POST", { name: "C14 Private" })).json.folder as { id: string }).id;
  folders.push(f);
  const g = ((await api("/api/folders", ownerC, "POST", { name: "C14 Inner", parentId: f })).json.folder as { id: string }).id;
  folders.push(g);
  const p2 = await mk("Cycle 14 nested");
  await db.project.update({ where: { id: p1 }, data: { folderId: f } });
  await db.project.update({ where: { id: p2 }, data: { folderId: g } });

  check("before restricting, a member sees the folder and its project", (await folderIds(memberC)).some((x) => x.id === f) && (await listIn(memberC, f)).includes(p1));
  const memberTry = await api("/api/folders", memberC, "PATCH", { id: f, restricted: true });
  check("a member can't restrict a folder", memberTry.status === 403, String(memberTry.status));
  await api("/api/folders", ownerC, "PATCH", { id: f, restricted: true });
  const mf = await folderIds(memberC);
  check("restricted folder and its subfolder are gone for a member", !mf.some((x) => x.id === f || x.id === g));
  check("its projects are gone from the member's lists and search", !(await listIn(memberC, f)).includes(p1) && !(await listIn(memberC, g)).includes(p2) && !JSON.stringify((await api(`/api/search?q=Cycle%2014`, memberC)).json).includes(p1));
  const open1 = await api(`/api/projects/${p1}/comments`, memberC);
  const open2 = await api(`/api/projects/${p2}/comments`, memberC);
  check("opening them directly is refused (nested too)", open1.status === 403 && open2.status === 403, `${open1.status}/${open2.status}`);
  check("the owner still sees everything", (await listIn(ownerC, f)).includes(p1) && (await folderIds(ownerC)).some((x) => x.id === f && x.restricted));

  const acc = (await api(`/api/folders?access=${f}`, ownerC)).json as { canManage: boolean; people: { id: string; canSee: boolean }[] };
  check("View access lists the member as unable to see it", acc.canManage && acc.people.some((p) => p.id === memberId && !p.canSee));
  const inner = (await api(`/api/folders?access=${g}`, ownerC)).json as { inheritedFrom: { id: string } | null };
  check("a subfolder's access comes from the restricted parent", inner.inheritedFrom?.id === f);
  const review = (await api(`/api/projects/access-review?ids=${p2}`, ownerC)).json as { projects: { visibility: string }[] };
  check("Review access names the restricting folder", /Restricted by the folder “C14 Private”/.test(review.projects?.[0]?.visibility ?? ""), review.projects?.[0]?.visibility);

  await api("/api/folders", ownerC, "PATCH", { id: f, addMember: memberId });
  check("adding the member to the folder lets them in (subfolder too)", (await listIn(memberC, f)).includes(p1) && (await listIn(memberC, g)).includes(p2) && (await api(`/api/projects/${p2}/comments`, memberC)).status === 200);
  await api("/api/folders", ownerC, "PATCH", { id: f, removeMember: memberId });
  await db.collaborator.create({ data: { projectId: p1, userId: memberId, role: "VIEWER" } });
  check("someone invited to one project keeps access to it", (await api(`/api/projects/${p1}/comments`, memberC)).status === 200 && (await api(`/api/projects/${p2}/comments`, memberC)).status === 403);
  await api("/api/folders", ownerC, "PATCH", { id: f, restricted: false });

  // ── Hidden folders ──
  await db.projectVisit.upsert({ where: { userId_projectId: { userId: memberId, projectId: p1 } }, create: { userId: memberId, projectId: p1 }, update: { at: new Date() } });
  await api("/api/folders", memberC, "PATCH", { id: f, hidden: true });
  check("hiding is per person", (await folderIds(memberC)).some((x) => x.id === f && x.hidden) && (await folderIds(ownerC)).some((x) => x.id === f && !x.hidden));
  check("projects in a hidden folder leave your other lists", !(await listIn(memberC, "root", "recent")).includes(p1) && (await listIn(memberC, "root", "hidden")).includes(p1));
  check("opening the hidden folder still shows its projects", (await listIn(memberC, f)).includes(p1));
  await api("/api/folders", memberC, "PATCH", { id: f, hidden: false });
  check("unhide brings them back", (await listIn(memberC, "root", "recent")).includes(p1) && !(await folderIds(memberC)).some((x) => x.id === f && x.hidden));

  // ── Element screenshot on a comment ──
  const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#6d4aff" } }).jpeg().toBuffer();
  const shot = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const c1 = await api(`/api/projects/${p1}/comments`, ownerC, "POST", { body: "Make this bigger", locator: "h1", selector: "h1", elementText: "Hi", elementShot: shot });
  await api(`/api/projects/${p1}/comments`, ownerC, "POST", { body: "No picture", locator: "p", selector: "p", elementShot: "javascript:alert(1)" });
  const threads = (await api(`/api/projects/${p1}/comments`, ownerC)).json.threads as { id: string; body: string; hasShot: boolean }[];
  check("thread keeps the element picture; junk is dropped", threads.find((t) => t.id === c1.json.id)?.hasShot === true && threads.find((t) => t.body === "No picture")?.hasShot === false);
  const img = await fetch(`${BASE}/api/projects/${p1}/comments?shot=${c1.json.id}`, { headers: { cookie: ownerC } });
  check("picture served as an image", img.headers.get("content-type") === "image/jpeg" && Buffer.from(await img.arrayBuffer()).equals(jpeg));

  // ── Recent assets on the dashboard ──
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#22aa66" } }).png().toBuffer();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "hero-shot.png");
  await fetch(`${BASE}/api/projects/${p1}/uploads`, { method: "POST", headers: { cookie: ownerC }, body: form });
  await db.projectVisit.upsert({ where: { userId_projectId: { userId: (await db.session.findUniqueOrThrow({ where: { sessionToken: token } })).userId, projectId: p1 } }, create: { userId: (await db.session.findUniqueOrThrow({ where: { sessionToken: token } })).userId, projectId: p1 }, update: { at: new Date() } });
  const dash = await (await fetch(`${BASE}/dashboard`, { headers: { cookie: ownerC } })).text();
  check("dashboard shows the recent assets strip", dash.includes("Recent assets") && dash.includes(`/projects/${p1}?tab=files`) && dash.includes("hero-shot.png"));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of projects) {
    await db.build.updateMany({ where: { projectId: id, status: "QUEUED" }, data: { status: "CANCELLED" } });
    await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie: `authjs.session-token=${token}` } });
  }
  if (folders.length) await db.folder.deleteMany({ where: { id: { in: folders } } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
