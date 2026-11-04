/**
 * Platform knowledge (the project's own knowledge base, workspace "platform"):
 * every AI's consult-first lookup and knowledge tools use it, the Knowledge app
 * never lists, searches, opens or answers from it, and its citations have no
 * article link. Plants one platform article and removes it afterwards.
 *   npx tsx scripts/test-knowledge-platform.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { consult, PLATFORM, putPlatformDoc, search, viewer } from "../src/lib/kb";

const [devToken] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const OWNER = `authjs.session-token=${devToken}`;
let fail = 0, pass = 0;
const check = (l: string, ok: boolean, x: unknown = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${l}${!ok && x ? `  ${JSON.stringify(x).slice(0, 400)}` : ""}`);
};
const api = async (url: string, body?: unknown) => {
  const r = await fetch(BASE + url, { method: body ? "POST" : "GET", headers: { cookie: OWNER, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};

const tag = `plat${Date.now().toString(36)}`;
const ext = `test:${tag}`;
try {
  const s = await db.session.findUnique({ where: { sessionToken: devToken } });
  const ws = (await db.membership.findFirst({ where: { userId: s!.userId, role: "OWNER" }, orderBy: { createdAt: "asc" } }))!.workspaceId;
  const v = await viewer(s!.userId, ws);
  check("a platform article is stored", (await putPlatformDoc(ext, { title: `Quillfeather onboarding ${tag}`, body: `# Onboarding\nEvery Quillfeather client gets a ${tag} kickoff within 48 hours.`, kind: "process", tags: ["company"], audience: "everyone", fileName: "x.md", hash: "1" })) === "added");
  check("…re-importing the same file changes nothing", (await putPlatformDoc(ext, { title: `Quillfeather onboarding ${tag}`, body: "x", kind: "process", tags: [], audience: "everyone", fileName: "x.md", hash: "1" })) === "same");
  const d = await db.kbDoc.findFirst({ where: { externalId: ext } });
  check("it lives in the platform scope, not a workspace", d?.workspaceId === PLATFORM);

  const c = await consult(v, `How fast is the Quillfeather kickoff ${tag}?`);
  check("every AI's consult-first lookup finds it", c.hits.some((h) => h.docId === d!.id && h.platform === true), c.hits.map((h) => h.title));
  check("…cited as read-only platform knowledge, without an article id", /platform knowledge, read-only/.test(c.context) && !c.context.includes(`id ${d!.id}`), c.context.slice(0, 300));
  check("the AI tools' search (platform: true) finds it", (await search(v, `Quillfeather kickoff ${tag}`, { platform: true })).some((h) => h.docId === d!.id));
  check("plain workspace search doesn't", !(await search(v, `Quillfeather kickoff ${tag}`)).some((h) => h.docId === d!.id));

  const list = await api("/api/kb");
  check("the Knowledge app's list doesn't show it", list.status === 200 && !JSON.stringify(list.json).includes(tag), list.status);
  const ks = await api(`/api/kb/search?q=${encodeURIComponent(`Quillfeather kickoff ${tag}`)}`);
  check("the Knowledge app's search doesn't find it", ks.status === 200 && !(ks.json.hits as any[]).some((h) => h.docId === d!.id));
  check("the Knowledge app can't open it", (await api(`/api/kb/${d!.id}`)).status === 404);
  const svc = await fetch(`${BASE}/api/iotx/kb`, { method: "POST", headers: { "content-type": "application/json", "x-iotx-key": process.env.IOTX_SERVICE_KEY ?? "" }, body: JSON.stringify({ userId: s!.userId, ws, query: `Quillfeather kickoff ${tag}`, limit: 5 }) }).then((r) => r.json());
  check("Workspace apps' AI (service route) gets it, flagged platform", (svc.hits as any[]).some((h) => h.docId === d!.id && h.platform === true), svc);

  process.env.PLATFORM_KB_WORKSPACES = "some-other-workspace";
  check("PLATFORM_KB_WORKSPACES limits which workspaces use it", !(await consult(v, `Quillfeather kickoff ${tag}`)).hits.some((h) => h.docId === d!.id));
  delete process.env.PLATFORM_KB_WORKSPACES;
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
} finally {
  await db.kbDoc.deleteMany({ where: { externalId: ext } });
  await db.$disconnect();
}
console.log(`\nKnowledge (platform): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
