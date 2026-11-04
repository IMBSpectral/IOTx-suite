/**
 * Draft diffs, free "Try to fix" (eligibility and daily cap), queue reordering,
 * Most visits / Design systems tabs, project analytics page, and the
 * key/personal-data checks used for attachments. The test project's queue is
 * paused, so no agent turn actually runs.
 *   npx tsx scripts/test-cycle7.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createDraft, checkoutDraft } from "../src/lib/drafts";
import { commit, writeFiles } from "../src/lib/repo";
import { draftDiff } from "../src/lib/branch-diff";
import { inspectOutgoing } from "../src/components/chat/ChatComposer";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const FIX = "Fix this error from the preview:\n\n";

let pid = "";
try {
  const created = await fetch(`${BASE}/api/projects`, json("POST", { name: "Cycle 7 test", force: true }));
  pid = ((await created.json()) as { project: { id: string } }).project.id;
  const owner = (await db.project.findUniqueOrThrow({ where: { id: pid } })).createdById!;

  // ── Draft diff ──
  const draft = await createDraft(pid, owner, "Diff test");
  await checkoutDraft(pid, draft.id);
  await writeFiles(pid, [
    { path: "src/App.tsx", content: "export default function App() {\n  return <h1>Changed title</h1>;\n}\n" },
    { path: "src/new.ts", content: "export const added = 1;\n" },
  ]);
  const sha = await commit(pid, "Diff test change");
  await db.draft.update({ where: { id: draft.id }, data: { headSha: sha, status: "READY" } });
  await checkoutDraft(pid, null);
  const d = await draftDiff(pid, draft.id);
  const app = d.files.find((f) => f.path === "src/App.tsx");
  const added = d.files.find((f) => f.path === "src/new.ts");
  check("diff lists modified and added files", app?.status === "modified" && added?.status === "added", d.files.map((f) => `${f.status} ${f.path}`).join(", "));
  check("unified patch with counts", !!app?.patch?.includes("+  return <h1>Changed title</h1>;") && app.additions >= 1 && app.deletions >= 1);
  const viaApi = await (await fetch(`${BASE}/api/projects/${pid}/drafts/${draft.id}/diff`, { headers: { cookie } })).json();
  check("diff API", viaApi.files?.length === d.files.length);
  check("diff needs access", (await fetch(`${BASE}/api/projects/${pid}/drafts/${draft.id}/diff`)).status === 401);
  await db.draft.update({ where: { id: draft.id }, data: { status: "REVERTED" } });

  // ── Free "Try to fix" ──
  await fetch(`${BASE}/api/projects/${pid}/queue`, json("POST", { action: "pause" }));
  const send = async (content: string, freeFix = true) => (await fetch(`${BASE}/api/projects/${pid}/messages`, json("POST", { content, mode: "build", freeFix }))).json();
  const ok = await send(`${FIX}TypeError: Cannot read properties of undefined (reading 'map')`);
  const b1 = await db.build.findUnique({ where: { id: ok.buildId } });
  check("real preview error: free", ok.free === true && b1?.free === true);
  const fake = await send(`${FIX}Also add a pricing page and a blog`);
  check("not an error: runs as a normal paid turn", fake.free === false && (await db.build.findUnique({ where: { id: fake.buildId } }))?.free === false, fake.freeReason);
  const other = await send("Make the header blue", false);
  check("normal message isn't free", !("free" in other) && (await db.build.findUnique({ where: { id: other.buildId } }))?.free === false);
  // Use up today's allowance on this account (messages in this throwaway project).
  const usedToday = await db.message.count({ where: { userId: owner, role: "USER", createdAt: { gte: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z") }, content: { startsWith: FIX } } });
  for (let i = usedToday; i < 5; i++) await db.message.create({ data: { projectId: pid, userId: owner, role: "USER", content: `${FIX}Error: filler ${i}`, mode: "build" } });
  const capped = await send(`${FIX}ReferenceError: x is not defined`);
  check("after 5 a day, fixes use credits", capped.free === false && /free fixes/.test(capped.freeReason ?? ""), capped.freeReason);

  // ── Queue reorder ──
  const queued = await db.build.findMany({ where: { projectId: pid, status: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const order = queued.map((q) => q.id).reverse();
  await fetch(`${BASE}/api/projects/${pid}/queue`, json("POST", { action: "reorder", order }));
  const after = await db.build.findMany({ where: { projectId: pid, status: "QUEUED" }, orderBy: [{ queuePos: "asc" }, { createdAt: "asc" }], select: { id: true } });
  check("queue reordered", after.map((b) => b.id).join() === order.join(), `${after.length} queued`);
  await fetch(`${BASE}/api/projects/${pid}/queue`, json("POST", { action: "clear" }));

  // ── Project tabs and analytics ──
  for (const view of ["popular", "design_systems"]) {
    const r = await fetch(`${BASE}/api/projects?view=${view}`, { headers: { cookie } });
    check(`${view} tab`, r.ok, String(r.status));
  }
  const popular = await (await fetch(`${BASE}/api/projects?view=popular`, { headers: { cookie } })).json();
  const list = (popular.projects ?? popular) as { visits7d: number; url: string | null }[];
  check("Most visits: published only, busiest first", list.every((p) => p.url) && list.every((p, i) => i === 0 || list[i - 1].visits7d >= p.visits7d));
  const page = await fetch(`${BASE}/projects/${pid}/analytics`, { headers: { cookie } });
  const html = await page.text();
  check("analytics page renders", page.ok && html.includes("Analytics") && html.includes("Visits per day"));

  // ── Attachment checks ──
  check("private key in an attachment is refused", inspectOutgoing("config\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...")?.kind === "block");
  check("API key in an attachment warns", inspectOutgoing("OPENAI=sk-proj-" + "a".repeat(40))?.kind === "warn");
  check("card number in an attachment warns", /payment card/.test(inspectOutgoing("Card: 4242 4242 4242 4242")?.message ?? ""));
  check("plain text is fine", inspectOutgoing("Just a CSV of products, price, stock") === null);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) {
    await db.build.updateMany({ where: { projectId: pid, status: "QUEUED" }, data: { status: "CANCELLED" } });
    const del = await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
    check("test project deleted", del.ok, String(del.status));
  }
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
