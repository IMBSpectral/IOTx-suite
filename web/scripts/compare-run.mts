/**
 * One side of a Forge-vs-Lovable comparison: send a prompt to a new Forge
 * project and play the user's part (approve Forge Cloud and database changes,
 * then say "continue") until the agent stops asking, up to 6 rounds.
 * Prints the project id, total time and credits as JSON.
 *   npx tsx scripts/compare-run.mts <devToken> "<name>" "<prompt>" [projectId]
 * With a projectId, the prompt is a follow-up in that project.
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, name, prompt, existing] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
const post = async (path: string, body: unknown) =>
  (await fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const t0 = Date.now();
const pid: string = existing ?? (await post("/api/projects", { name, force: true })).project.id;
let credits = 0;
let content = prompt;
const rounds: string[] = [];

for (let round = 0; round < 6 && content; round++) {
  const sent = await post(`/api/projects/${pid}/messages`, { content, mode: "build" });
  if (!sent.buildId) {
    rounds.push(`send failed: ${JSON.stringify(sent).slice(0, 200)}`);
    break;
  }
  let b = null;
  for (let i = 0; i < 400; i++) {
    b = await db.build.findUnique({ where: { id: sent.buildId } });
    if (b && !["QUEUED", "RUNNING"].includes(b.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  credits += b?.creditsUsed ?? 0;
  const msg = await db.message.findUnique({ where: { id: sent.messageId } });
  const steps = ((msg?.steps as string[]) ?? []).filter((s) => !s.startsWith("call:"));
  rounds.push(`${b?.status} ${b?.creditsUsed}cr`);
  content = "";
  // What a user would click on the cards this turn left.
  if (steps.some((s) => s.startsWith("cloud:request"))) {
    await post(`/api/projects/${pid}/cloud`, { action: "enable" });
    content = "I enabled Forge Cloud. Continue building.";
    continue;
  }
  const migrations = steps.filter((s) => s.startsWith("migration:")).map((s) => s.split(":")[1]);
  if (migrations.length) {
    for (const id of migrations) await post(`/api/projects/${pid}/cloud`, { action: "approve", id });
    content = "I approved the database changes. Continue building.";
  }
}

console.log(JSON.stringify({ pid, seconds: Math.round((Date.now() - t0) / 1000), credits, rounds }));
await db.$disconnect();
