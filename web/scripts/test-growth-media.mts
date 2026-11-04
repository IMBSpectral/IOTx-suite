/**
 * Image editor, a draft's own backend, bonuses, surveys and announcements.
 * Makes one real image edit (OpenAI) and boots one preview container.
 * Throwaway rows and projects only; the dev workspace is charged the image
 * edit's credits.
 *   npx tsx scripts/test-growth-media.mts <devToken>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db } from "../src/lib/db";
import { editPrompt } from "../src/lib/images";
import { closeDatabase, enableCloud, getCloud, openDatabase, draftDatabaseExists } from "../src/lib/cloud";
import { createDraft } from "../src/lib/drafts";
import { createDraftBackend } from "../src/lib/draft-data";
import { claimReward, rewardsFor, WELCOME_BACK_CREDITS } from "../src/lib/rewards";
import { activeAnnouncements, answerSurvey, readAnnouncements, surveyDue } from "../src/lib/engagement";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const rnd = () => Math.random().toString(36).slice(2, 10);
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const userIds: string[] = [];
const wsIds: string[] = [];
let pid = "";

try {
  // ── Image edit prompt ──
  const p = editPrompt("erase", "", [{ x: 0.25, y: 0.5, note: "remove the mug" }]);
  check("erase prompt + pinned note with position", /Remove whatever is in the marked area/.test(p) && /25% from the left and 50% from the top: remove the mug/.test(p) && /Leave everything else/.test(p));
  check("plain edit prompt", editPrompt("edit", "make the sky orange", []).startsWith("make the sky orange"));

  // ── Rewards ──
  const u = await db.user.create({ data: { email: `r-${rnd()}@example.test` } });
  userIds.push(u.id);
  const ws = await db.workspace.create({ data: { name: "Rewards test", slug: `rw-${rnd()}`, creditBalance: 0 } });
  wsIds.push(ws.id);
  await db.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "OWNER" } });
  let r = await rewardsFor(u.id);
  check("nothing earned yet", r.rewards.every((x) => !x.earned) && !r.daily.claimed && r.welcomeBack === null);
  let err = "";
  await claimReward(u.id, "first-project", ws.id).catch((e) => (err = e.message));
  check("unearned reward can't be claimed", /Finish it first/.test(err));
  const proj = await db.project.create({ data: { workspaceId: ws.id, name: "R app", slug: `r-${rnd()}`, subdomain: `r-${rnd()}`, createdById: u.id } });
  r = await rewardsFor(u.id);
  check("creating a project earns its reward", r.rewards.find((x) => x.id === "first-project")?.earned === true);
  await claimReward(u.id, "first-project", ws.id);
  let w = await db.workspace.findUniqueOrThrow({ where: { id: ws.id } });
  check("claim adds credits", w.creditBalance === 5);
  check("ledger records a bonus", !!(await db.creditEntry.findFirst({ where: { workspaceId: ws.id, reason: "BONUS", delta: 5 } })));
  err = "";
  await claimReward(u.id, "first-project", ws.id).catch((e) => (err = e.message));
  check("each reward claims once", /Already claimed/.test(err));
  await claimReward(u.id, r.daily.id, ws.id);
  check("daily bonus", (await db.workspace.findUniqueOrThrow({ where: { id: ws.id } })).creditBalance === 6);
  const other = await db.workspace.create({ data: { name: "Not mine", slug: `nm-${rnd()}` } });
  wsIds.push(other.id);
  err = "";
  await claimReward(u.id, "daily:2000-01-01", other.id).catch((e) => (err = e.message));
  check("can't claim into someone else's workspace", /workspace you belong to/.test(err));
  // Back after 40 days away.
  await db.message.create({ data: { projectId: proj.id, userId: u.id, role: "USER", content: "old", createdAt: new Date(Date.now() - 40 * 86_400_000) } });
  r = await rewardsFor(u.id);
  check("welcome-back gift offered after a long break", !!r.welcomeBack && !r.welcomeBack.claimed);
  await claimReward(u.id, r.welcomeBack!.id, ws.id);
  w = await db.workspace.findUniqueOrThrow({ where: { id: ws.id } });
  check("welcome-back gift claimed", w.creditBalance === 6 + WELCOME_BACK_CREDITS);

  // ── Survey ──
  check("no survey before using Forge", !(await surveyDue(u.id)));
  for (let i = 0; i < 3; i++) await db.message.create({ data: { projectId: proj.id, userId: u.id, role: "USER", content: `msg ${i}` } });
  check("survey due after a few messages", await surveyDue(u.id));
  err = "";
  await answerSurvey(u.id, { score: 11 }).catch((e) => (err = e.message));
  check("score must be 0–10", /0 to 10/.test(err));
  await answerSurvey(u.id, { score: 9, answer: "Fast" });
  check("answer stored, not asked again", !(await surveyDue(u.id)) && (await db.surveyResponse.findFirst({ where: { userId: u.id } }))?.score === 9);

  // ── Announcements ──
  const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "forge-ann-")), "a.json");
  await fs.writeFile(
    tmp,
    JSON.stringify([
      { id: "old", title: "Old", body: "x", endsAt: "2020-01-01T00:00:00Z" },
      { id: "future", title: "Future", body: "x", startsAt: "2099-01-01T00:00:00Z" },
      { id: "a", title: "A", body: "x", startsAt: "2026-01-01T00:00:00Z" },
      { id: "b", title: "B", body: "x", startsAt: "2026-06-01T00:00:00Z" },
      { title: "no id" },
    ]),
  );
  const active = activeAnnouncements(await readAnnouncements(tmp));
  check("only current announcements, newest first", active.map((a) => a.id).join(",") === "b,a");
  check("missing file is no announcements", (await readAnnouncements(tmp + ".missing")).length === 0);

  if (token) {
    for (const [route, key] of [["/api/rewards", "rewards"], ["/api/survey", "survey"], ["/api/announcements", "announcements"]] as const) {
      const res = await fetch(BASE + route, { headers: { cookie } });
      check(`${route} responds`, res.ok && key in (await res.json()));
    }
    check("rewards page renders", (await (await fetch(`${BASE}/rewards`, { headers: { cookie } })).text()).includes("Earn bonuses"));

    const created = await fetch(`${BASE}/api/projects`, json("POST", { name: "Growth media test", force: true }));
    pid = ((await created.json()) as { project: { id: string } }).project.id;

    // ── Image editor ──
    const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 120, b: 220 } } })
      .composite([{ input: Buffer.from('<svg width="256" height="256"><circle cx="128" cy="128" r="60" fill="#ffcc00"/></svg>') }])
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "sun.png");
    const up = (await (await fetch(`${BASE}/api/projects/${pid}/uploads`, { method: "POST", headers: { cookie }, body: form })).json()).attachments[0];
    check("no prompt is refused", (await fetch(`${BASE}/api/projects/${pid}/image-edit`, json("POST", { uploadId: up.id, mode: "edit" }))).status === 400);
    check("erase needs a mask", (await fetch(`${BASE}/api/projects/${pid}/image-edit`, json("POST", { uploadId: up.id, mode: "erase" }))).status === 400);
    check("unknown image refused", (await fetch(`${BASE}/api/projects/${pid}/image-edit`, json("POST", { uploadId: crypto.randomUUID(), prompt: "x" }))).status === 400);
    const mask = await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
      .composite([{ input: Buffer.from('<svg width="256" height="256"><circle cx="128" cy="128" r="70" fill="black"/></svg>'), blend: "dest-out" }])
      .png()
      .toBuffer();
    const t0 = Date.now();
    const edit = await fetch(
      `${BASE}/api/projects/${pid}/image-edit`,
      json("POST", { uploadId: up.id, mode: "edit", prompt: "Turn the yellow circle into a red heart", mask: `data:image/png;base64,${mask.toString("base64")}` }),
    );
    const eb = await edit.json();
    check("real image edit returns a new .edit.png attachment", edit.status === 201 && /^sun\.edit\.png$/.test(eb.attachment?.name ?? ""), `${edit.status} ${JSON.stringify(eb).slice(0, 160)} (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (edit.status === 201) {
      const img = await fetch(`${BASE}/api/projects/${pid}/uploads/${eb.attachment.id}`, { headers: { cookie } });
      const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
      check("edited image is a real PNG", img.ok && meta.format === "png", `${meta.width}x${meta.height}`);
      check("original untouched", (await fetch(`${BASE}/api/projects/${pid}/uploads/${up.id}`, { headers: { cookie } })).ok);
    }

    // ── A draft's own backend ──
    await enableCloud(pid);
    const live = openDatabase(pid);
    await live.exec(`CREATE TABLE authors (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT);
               CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT, author_id TEXT REFERENCES authors(id), published INTEGER DEFAULT 0, created_at TEXT);
               INSERT INTO authors (id, name) VALUES ('live-1', 'Live Person');`);
    const owner = (await db.project.findUniqueOrThrow({ where: { id: pid } })).createdById!;
    const draft = await createDraft(pid, owner, "Data test");
    const made = await createDraftBackend(pid, draft.id);
    check("draft backend seeds every table", made.tables.authors === 5 && made.tables.posts === 5, JSON.stringify(made.tables));
    const dd = openDatabase(`${pid}@${draft.id}`);
    const post = (await dd.get("SELECT title, author_id FROM posts LIMIT 1")) as { title: string; author_id: string };
    check("example rows look real and keep foreign keys", /post 1/i.test(post.title) && !!(await dd.get("SELECT 1 FROM authors WHERE id = ?", [post.author_id])), JSON.stringify(post));
    check("live data untouched", Number((await live.get<{ n: number }>("SELECT COUNT(*) AS n FROM posts"))!.n) === 0 && Number((await live.get<{ n: number }>("SELECT COUNT(*) AS n FROM authors"))!.n) === 1);
    check("draft data doesn't include live rows", !(await dd.get("SELECT 1 FROM authors WHERE id = 'live-1'")));

    const list = await (await fetch(`${BASE}/api/projects/${pid}/drafts`, { headers: { cookie } })).json();
    check("draft list says Cloud is on and this draft has its own backend", list.cloud === true && list.drafts.find((d: { id: string }) => d.id === draft.id)?.ownBackend === true);

    // End to end: the preview of the open draft reads the draft's rows; anything else reads live.
    await fetch(`${BASE}/api/projects/${pid}/drafts/${draft.id}`, json("POST", { action: "checkout" }));
    const sb = await (await fetch(`${BASE}/api/projects/${pid}/sandbox`, json("POST", {}))).json();
    const cfg = (await getCloud(pid))!;
    const restUrl = `${BASE}/cloud/v1/${pid}/rest/authors`;
    const fromPreview = await (await fetch(restUrl, { headers: { apikey: cfg.anonKey, origin: sb.url ?? "" } })).json();
    const fromElsewhere = await (await fetch(restUrl, { headers: { apikey: cfg.anonKey, origin: "https://someone-else.example" } })).json();
    const rows = (x: unknown) => (Array.isArray(x) ? x : ((x as { rows?: unknown[]; data?: unknown[] }).rows ?? (x as { data?: unknown[] }).data ?? []));
    check("preview of the draft reads the draft's data", sb.status === "ready" && rows(fromPreview).length === 5, `${sb.status} ${JSON.stringify(fromPreview).slice(0, 100)}`);
    check("other origins read live data", rows(fromElsewhere).length === 1, JSON.stringify(fromElsewhere).slice(0, 100));

    // Windows won't delete a database file this process still has open.
    closeDatabase(`${pid}@${draft.id}`);
    closeDatabase(pid);
    const off = await (await fetch(`${BASE}/api/projects/${pid}/drafts/${draft.id}`, json("POST", { action: "backend", on: false }))).json();
    check("turning it off removes the draft database", off.ownBackend === false && !(await draftDatabaseExists(pid, draft.id)), JSON.stringify(off));
    const on = await (await fetch(`${BASE}/api/projects/${pid}/drafts/${draft.id}`, json("POST", { action: "backend", on: true }))).json();
    check("turning it on over HTTP", on.ownBackend === true && on.tables?.posts === 5);
    await db.draft.update({ where: { id: draft.id }, data: { status: "READY" } });
    await fetch(`${BASE}/api/projects/${pid}/drafts/${draft.id}`, json("POST", { action: "discard" }));
    check("discarding the draft removes its database", !(await draftDatabaseExists(pid, draft.id)));
  }
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) {
    const del = await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
    check("test project deleted", del.ok, String(del.status));
  }
  await db.surveyResponse.deleteMany({ where: { userId: { in: userIds } } });
  await db.rewardClaim.deleteMany({ where: { userId: { in: userIds } } });
  await db.workspace.deleteMany({ where: { id: { in: wsIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
