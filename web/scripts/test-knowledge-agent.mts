/**
 * One real Builder turn (Ask mode, spends a few credits): the platform looks
 * the question up in the knowledge base first and the agent answers with the
 * company fact. Cleans up the
 * article and the turn's messages afterwards.
 *   npx tsx scripts/test-knowledge-agent.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const [devToken] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const OWNER = `authjs.session-token=${devToken}`;
const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2"; // throwaway smoke-test project
const tag = `kba${Date.now().toString(36)}`;
let fail = 0;
const check = (l: string, ok: boolean, x: unknown = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${l}${!ok && x ? `  ${JSON.stringify(x).slice(0, 600)}` : ""}`); };
const api = async (url: string, body?: unknown) => {
  const r = await fetch(BASE + url, { method: body ? "POST" : "GET", headers: { cookie: OWNER, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};

const started = new Date();
let docId = "";
try {
  const a = await api("/api/kb", { title: `Zinc coating standard ${tag}`, kind: "product", body: `# Coating\nOur standard zinc coating for GP coils is Z275 (275 g/m²). Premium orders use Z350. ${tag}` });
  docId = a.json.doc.id;
  const m = await api(`/api/projects/${PID}/messages`, { content: "Using our company knowledge base: what zinc coating do we use as standard for GP coils? Answer in one line.", mode: "ask" });
  check("an Ask turn starts", m.status < 300, m.json);
  let build: any = null;
  for (let i = 0; i < 90; i++) {
    build = await db.build.findFirst({ where: { projectId: PID, createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
    if (build && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(build.status))) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  check("the turn finishes", build?.status === "SUCCEEDED", build?.status);
  const events = await db.buildEvent.findMany({ where: { buildId: build?.id }, orderBy: { seq: "asc" } });
  const steps = events.map((e) => JSON.stringify(e.payload)).join("\n");
  // Knowledge first: the platform looks the question up before the agent acts, so the agent needn't search itself.
  check("the platform checked the company knowledge base before the agent acted", /Checked company knowledge \(\d+ passages?\)/.test(steps), steps.slice(0, 400));
  const reply = await db.message.findFirst({ where: { projectId: PID, role: "ASSISTANT", createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
  check("its answer uses the company's value (Z275)", /Z275/i.test(reply?.content ?? ""), reply?.content);
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
} finally {
  if (docId) await db.kbDoc.deleteMany({ where: { id: docId } });
  await db.message.deleteMany({ where: { projectId: PID, createdAt: { gte: started } } });
  await db.build.deleteMany({ where: { projectId: PID, createdAt: { gte: started } } });
  await db.kbGap.deleteMany({ where: { question: { contains: "zinc coating" } } });
  await db.$disconnect();
}
console.log(`\nKnowledge (agent): ${fail ? "FAILED" : "all passed"}`);
process.exit(fail ? 1 : 0);
