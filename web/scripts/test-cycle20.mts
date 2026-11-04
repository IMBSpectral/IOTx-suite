/**
 * Build pipeline after the comparison fixes: an unpublished project builds
 * straight onto main (no draft, committed, head moves); a published one still
 * builds in a draft; a turn that runs out of credits pauses with a
 * "paused:credits" step; several projects build at once. Uses live turns
 * and restores the workspace balance afterwards.
 *   npx tsx scripts/test-cycle20.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const post = async (path: string, body: unknown) =>
  (await fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const waitBuild = async (id: string, secs = 600) => {
  for (let i = 0; i < secs / 2; i++) {
    const b = await db.build.findUnique({ where: { id } });
    if (b && !["QUEUED", "RUNNING"].includes(b.status)) return b;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
};
const projects: string[] = [];
let wsId = "";
let balanceBefore = 0;

try {
  const mk = async (name: string) => {
    const id = (await post("/api/projects", { name, force: true })).project.id as string;
    projects.push(id);
    return id;
  };
  const small = "Change the main heading text to 'Hello from Forge'. Nothing else.";

  // ── Unpublished: straight onto main, two projects at once ──
  const a = await mk("C20 main A");
  const b = await mk("C20 main B");
  wsId = (await db.project.findUniqueOrThrow({ where: { id: a } })).workspaceId;
  balanceBefore = (await db.workspace.findUniqueOrThrow({ where: { id: wsId } })).creditBalance;
  const headA = (await db.project.findUniqueOrThrow({ where: { id: a } })).headSha;
  const [sa, sb] = await Promise.all([post(`/api/projects/${a}/messages`, { content: small, mode: "build" }), post(`/api/projects/${b}/messages`, { content: small, mode: "build" })]);
  await new Promise((r) => setTimeout(r, 4000));
  const running = await db.build.count({ where: { id: { in: [sa.buildId, sb.buildId] }, status: "RUNNING" } });
  check("two projects build at the same time", running === 2, `${running} running`);
  const [ba] = await Promise.all([waitBuild(sa.buildId), waitBuild(sb.buildId)]);
  const pa = await db.project.findUniqueOrThrow({ where: { id: a } });
  check("an unpublished project builds without a draft", ba?.status === "SUCCEEDED" && !ba.draftId && (await db.draft.count({ where: { projectId: a } })) === 0, `${ba?.status} draft=${ba?.draftId}`);
  check("its change is committed and the head moves", !!ba?.sha && pa.headSha === ba.sha && pa.headSha !== headA, `${headA?.slice(0, 7)} -> ${pa.headSha?.slice(0, 7)}`);

  // ── Published: changes go to a draft ──
  const pub = await fetch(`${BASE}/api/projects/${a}/publish`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
  await pub.text();
  const sp = await post(`/api/projects/${a}/messages`, { content: "Change the main heading text to 'Hello again'. Nothing else.", mode: "build" });
  const bp = await waitBuild(sp.buildId);
  const head2 = (await db.project.findUniqueOrThrow({ where: { id: a } })).headSha;
  check("a published project builds in a draft and main stays put", bp?.status === "SUCCEEDED" && !!bp.draftId && head2 === pa.headSha, `draft=${bp?.draftId} head ${head2?.slice(0, 7)}`);

  // ── Running out of credits pauses the turn ──
  const c = await mk("C20 credits");
  await db.workspace.update({ where: { id: wsId }, data: { creditBalance: 1 } });
  const sc = await post(`/api/projects/${c}/messages`, {
    content: "Build a full multi-page website for a bakery: home, menu with 20 items, about, gallery, contact form, and a blog with 5 posts. Make it detailed.",
    mode: "build",
  });
  const bc = await waitBuild(sc.buildId);
  const msg = await db.message.findUnique({ where: { id: sc.messageId } });
  const steps = (msg?.steps as string[]) ?? [];
  check("a turn that runs out of credits pauses", bc?.status === "CANCELLED" && steps.includes("paused:credits"), `${bc?.status} credits=${bc?.creditsUsed}`);
  const bal = (await db.workspace.findUniqueOrThrow({ where: { id: wsId } })).creditBalance;
  check("the balance stops at zero", bal === 0, String(bal));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (wsId) await db.workspace.update({ where: { id: wsId }, data: { creditBalance: balanceBefore } });
  for (const id of projects) {
    await db.build.updateMany({ where: { projectId: id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED" } });
    await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
