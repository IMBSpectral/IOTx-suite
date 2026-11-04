/**
 * Forge Cloud operations end to end: health, the linter, AI for the app (a
 * real model call, charged), email to the outbox (signed-in users only,
 * validation), pausing by hand with the cooldown, waking, auto-pause after a
 * week idle, restart, turning AI off, and refreshing an older client file.
 * Uses a throwaway project that is permanently deleted at the end.
 * Proposing a migration is an agent tool, so the test calls the library for it.
 *   npx tsx scripts/test-cloud-ops.mts <devToken>
 */
import "dotenv/config";
import fs from "node:fs";
import { closeDatabase, proposeMigration } from "../src/lib/cloud";
import { PROJECTS_ROOT as ROOT } from "../src/lib/paths";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function editor(path: string, json?: unknown, method?: string) {
  const res = await fetch(BASE + path, {
    method: method ?? (json === undefined ? "GET" : "POST"),
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

let pid = "";

async function main() {
  pid = (await editor("/api/projects", { name: "Cloud ops test", force: true })).body.project.id;
  const C = `/api/projects/${pid}/cloud`;
  check("enable cloud", (await editor(C, { action: "enable" })).status === 200);
  const key = (await editor(C)).body.anonKey as string;
  const app = async (p: string, init: { method?: string; body?: unknown; bearer?: string } = {}) => {
    const res = await fetch(`${BASE}/cloud/v1/${pid}${p}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { apikey: key, "content-type": "application/json", ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };

  // ── Health ───────────────────────────────────────────────────
  let h = (await editor(`${C}?view=health`)).body;
  check("starts healthy", h.status === "healthy" && h.paused === null, h.status);
  check("AI and email on by default", h.ai.enabled && h.email.enabled && !h.email.connected);

  // ── Linter ───────────────────────────────────────────────────
  const mid = await proposeMigration(pid, "Notes", "CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT, body TEXT, api_key TEXT); CREATE TABLE logs (msg TEXT)");
  await editor(C, { action: "approve", id: mid });
  await proposeMigration(pid, "Later", "CREATE TABLE later (id TEXT PRIMARY KEY)");
  const signup = await app("/auth/signup", { body: { email: "ops@example.com", password: "longpassword" } });
  const bearer = signup.body.token as string;
  check("app user signs up", signup.status === 201 && !!bearer);
  check("row inserted", (await app("/rest/notes", { body: { id: "n1", body: "hi" }, bearer })).status === 201);
  const lint = (await editor(`${C}?view=lint`)).body.findings as any[];
  const has = (id: string) => lint.some((f) => f.id === id);
  check("sensitive public column is an error", has("sensitive-public:notes") && lint[0].severity === "error");
  check("default access flagged", has("default-access:notes") && has("default-access:logs"));
  check("missing primary key flagged", has("no-pk:logs") && !has("no-pk:notes"));
  check("unindexed user_id flagged", has("user-id-index:notes"));
  check("pending migration listed", has("pending-migrations"));
  await editor(C, { action: "policy", table: "notes", read: "owner", write: "owner" });
  const lint2 = (await editor(`${C}?view=lint`)).body.findings as any[];
  check("owner rule clears the leak and default warnings", !lint2.some((f) => f.id === "sensitive-public:notes" || f.id === "default-access:notes"));

  // Optimize database: the missing indexes arrive as one migration waiting for approval.
  const opt = await editor(C, { action: "optimize" });
  check("optimize proposes a migration", opt.status === 200 && typeof opt.body.migration === "string");
  const optM = (await editor(C)).body.migrations.find((m: any) => m.id === opt.body.migration);
  check("it adds the user_id index", optM?.status === "pending" && /CREATE INDEX[^;]*notes[^;]*user_id/.test(optM.sql), optM?.description);
  await editor(C, { action: "approve", id: opt.body.migration });
  const lint3 = (await editor(`${C}?view=lint`)).body.findings as any[];
  check("index finding gone after approval", !lint3.some((f) => f.id === "user-id-index:notes"));
  check("nothing left to optimize", (await editor(C, { action: "optimize" })).body.migration === null);

  // ── AI ───────────────────────────────────────────────────────
  check("AI needs messages", (await app("/ai/chat", { body: { messages: [] } })).status === 400);
  check("AI rejects bad roles", (await app("/ai/chat", { body: { messages: [{ role: "system", content: "x" }] } })).status === 400);
  check("AI first message must be the user's", (await app("/ai/chat", { body: { messages: [{ role: "assistant", content: "x" }] } })).status === 400);
  const ai = await app("/ai/chat", { body: { messages: [{ role: "user", content: "Reply with exactly the word: pong" }], maxTokens: 20 } });
  check("AI answers", ai.status === 200 && /pong/i.test(ai.body.text), `${ai.status} ${JSON.stringify(ai.body).slice(0, 120)}`);
  h = (await editor(`${C}?view=health`)).body;
  check("AI use counted and charged", h.ai.callsToday === 1 && h.ai.creditsToday >= 1, `${h.ai.callsToday} calls, ${h.ai.creditsToday} credits`);

  // ── Email ────────────────────────────────────────────────────
  const mail = { to: "friend@example.com", subject: "Hello", text: "Testing the outbox." };
  check("email needs a signed-in user", (await app("/email/send", { body: mail })).status === 401);
  check("email rejects a bad address", (await app("/email/send", { body: { ...mail, to: "nope" }, bearer })).status === 400);
  check("email rejects two addresses", (await app("/email/send", { body: { ...mail, to: "a@x.com, b@x.com" }, bearer })).status === 400);
  check("email needs a body", (await app("/email/send", { body: { ...mail, text: "" }, bearer })).status === 400);
  const sent = await app("/email/send", { body: mail, bearer });
  check("email captured without a provider", sent.status === 201 && sent.body.status === "captured");
  const box = (await editor(`${C}?view=outbox`)).body.emails as any[];
  check("outbox shows it with the sender", box[0]?.subject === "Hello" && box[0]?.by === "ops@example.com");

  // ── Pause, cooldown, wake ────────────────────────────────────
  check("pause", (await editor(C, { action: "pause" })).status === 200);
  const paused = await app("/rest/notes", { bearer });
  check("paused backend answers 503", paused.status === 503 && /paused/i.test(paused.body.error));
  check("auth is paused too", (await app("/auth/login", { body: { email: "ops@example.com", password: "longpassword" } })).status === 503);
  check("pausing twice is refused", (await editor(C, { action: "pause" })).status === 409);
  check("health says paused", (await editor(`${C}?view=health`)).body.paused?.reason === "manual");
  const tooSoon = await editor(C, { action: "wake" });
  check("wake waits for the cooldown", tooSoon.status === 429, tooSoon.body.error);
  await sleep(31_000);
  check("wake", (await editor(C, { action: "wake" })).status === 200);
  check("backend answers again", (await app("/rest/notes", { bearer })).status === 200);
  check("waking a running backend is refused", (await editor(C, { action: "wake" })).status === 409);

  // ── Auto-pause after a week idle ─────────────────────────────
  const cfgFile = `${ROOT}/_cloud/${pid}/config.json`;
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.lastActiveAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const idle = await app("/rest/notes", { bearer });
  check("idle backend pauses on the next request", idle.status === 503 && /week/i.test(idle.body.error), idle.body.error);
  check("pause reason is inactivity", (await editor(`${C}?view=health`)).body.paused?.reason === "inactivity");
  await sleep(31_000); // the earlier manual wake started a cooldown
  check("wake after inactivity", (await editor(C, { action: "wake" })).status === 200);
  check("woken after inactivity", (await app("/rest/notes", { bearer })).status === 200);

  // ── Restart, AI off, client refresh ──────────────────────────
  check("restart", (await editor(C, { action: "restart" })).status === 200 && (await app("/rest/notes", { bearer })).status === 200);
  await editor(C, { action: "features", ai: false });
  check("AI off is refused", (await app("/ai/chat", { body: { messages: [{ role: "user", content: "hi" }] } })).status === 403);
  await editor(C, { action: "features", ai: true });
  check("client refresh", (await editor(C, { action: "refreshClient" })).status === 200);
  const client = (await editor(`/api/projects/${pid}/files?path=src/integrations/cloud/client.ts`)).body.content as string;
  check("client has ai and email", client.includes("ai: {") && client.includes("/email/send"));
}

main()
  .catch((e) => {
    console.log("FAIL crashed —", e);
    failures++;
  })
  .finally(async () => {
    // This process opened the database to propose migrations; let go of it so the server can delete it.
    closeDatabase(pid);
    if (pid) await editor(`/api/projects/${pid}?permanent=1`, undefined, "DELETE");
    check("cloud data purged", !fs.existsSync(`${ROOT}/_cloud/${pid}`));
    console.log(failures ? `\n${failures} failed` : "\nAll passed");
    process.exit(failures ? 1 : 0);
  });
