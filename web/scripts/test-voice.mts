/**
 * Voice mode over HTTP: a real Realtime session secret from OpenAI (no audio,
 * so no usage), saving a call transcript to the chat, the daily limit, and
 * access rules. Resets the test user's voice usage afterwards.
 *   npx tsx scripts/test-voice.mts <devToken> <projectId> <userId>
 */
import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const BASE = "http://localhost:3000";
const [token, pid, userId] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function call(json?: unknown) {
  const res = await fetch(`${BASE}/api/projects/${pid}/voice`, {
    method: json === undefined ? "GET" : "POST",
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const usageFile = path.join(process.env.PROJECTS_ROOT ?? "", "_voice", `${userId}.json`);

async function main() {
  await fs.rm(usageFile, { force: true });
  const left = await call();
  check("time left reported", left.status === 200 && left.body.secondsLeft === left.body.daily, JSON.stringify(left.body));

  const start = await call({ action: "start" });
  check("session secret minted by OpenAI", start.status === 200 && /^ek_/.test(start.body.clientSecret ?? ""), start.body.error ?? `model ${start.body.model}`);
  check("real API key never sent to the browser", !JSON.stringify(start.body).includes(process.env.OPENAI_API_KEY ?? "@@"));

  const end = await call({
    action: "end",
    seconds: 42,
    transcript: [
      { role: "user", text: "Make the header sticky." },
      { role: "assistant", text: "Sent that to the build agent." },
    ],
  });
  check("call end records time", end.status === 200 && end.body.secondsLeft === left.body.daily - 42, JSON.stringify(end.body));
  const msgs = (await (await fetch(`${BASE}/api/projects/${pid}/messages`, { headers: { cookie: `authjs.session-token=${token}` } })).json()).messages as any[];
  const saved = msgs.find((m) => m.mode === "voice" && m.content.includes("Make the header sticky."));
  check("transcript saved to the chat", !!saved && saved.content.includes("**Forge:** Sent that to the build agent."));

  await call({ action: "end", seconds: left.body.daily });
  const blocked = await call({ action: "start" });
  check("daily limit enforced", blocked.status === 429 && /voice time limit/.test(blocked.body.error ?? ""), blocked.body.error);

  check("unauthenticated refused", (await fetch(`${BASE}/api/projects/${pid}/voice`)).status === 401);
  await fs.rm(usageFile, { force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
