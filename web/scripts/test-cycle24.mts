/**
 * Workspace secrets (inherited, overridden, admin-only), app sign-in settings
 * (password off, email codes, closed sign-up, allowed domains), the AI
 * activity log (bodies only when asked, monthly credit limit) and disabling
 * Cloud with a typed confirmation.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle24.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fetchRetry: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    await sleep(500);
    return fetch(input, init);
  }
};
const call = async (p: string, body?: unknown, c = cookie) => {
  const r = await fetchRetry(`${BASE}${p}`, body === undefined ? { headers: { cookie: c } } : { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
let pid = "";

try {
  pid = ((await call("/api/projects", { name: "C24 settings", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const A = `/api/projects/${pid}/cloud/admin`;
  const C = `${BASE}/cloud/v1/${pid}`;
  const app = (p: string, body?: unknown, tok?: string) =>
    fetchRetry(`${C}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { apikey: anonKey, "user-agent": UA, "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  // ── Workspace secrets
  check("bad secret names are refused", (await call("/api/workspace/secrets", { action: "set", name: "lower", value: "x" })).status === 400);
  await call("/api/workspace/secrets", { action: "set", name: "C24_SHARED", value: "from-workspace" });
  const listed = (await call("/api/workspace/secrets")).json.secrets as { name: string }[];
  check("workspace secrets are listed by name only", listed.some((s) => s.name === "C24_SHARED") && !JSON.stringify(listed).includes("from-workspace"));
  const member = await call("/api/workspace/secrets", undefined, `authjs.session-token=${users["member@localhost"]}`);
  check("other people never see this workspace's secrets", member.status === 403 || !JSON.stringify(member.json).includes("C24_SHARED"), String(member.status));
  const cloud = (await call(`/api/projects/${pid}/cloud`)).json as { inheritedSecrets: string[] };
  check("the project shows the secret as inherited", cloud.inheritedSecrets.includes("C24_SHARED"));
  const f = path.join(ROOT, pid, "functions", "env.ts");
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, `export default () => ({ shared: process.env.C24_SHARED ?? null });`);
  await call(A, { action: "deployFunctions" });
  const e1 = (await (await app("/functions/env")).json()) as { shared: string };
  check("server functions get workspace secrets", e1.shared === "from-workspace", JSON.stringify(e1));
  await call(`/api/projects/${pid}/cloud`, { action: "setSecret", name: "C24_SHARED", value: "from-project" });
  const e2 = (await (await app("/functions/env")).json()) as { shared: string };
  check("a project secret with the same name wins", e2.shared === "from-project", JSON.stringify(e2));
  check("and it's no longer listed as inherited", !((await call(`/api/projects/${pid}/cloud`)).json.inheritedSecrets as string[]).includes("C24_SHARED"));

  // ── Sign-in settings
  const s0 = (await call(`${A}?view=settings`)).json.auth as Record<string, unknown>;
  check("sign-in starts as email + password with open sign-up", s0.password === true && s0.emailCode === false && s0.signups === true);
  check("at least one method must stay on", (await call(A, { action: "setAuth", auth: { password: false, forge: false } })).status === 400);
  await call(A, { action: "setAuth", auth: { emailCode: true, password: false } });
  check("with passwords off, password sign-up is refused", (await app("/auth/signup", { email: "ana@example.com", password: "password123" })).status === 403);
  const sent = await app("/auth/otp", { email: "ana@example.com" });
  check("a sign-in code can be requested", sent.status === 200);
  const outbox = (await call(`/api/projects/${pid}/cloud?view=outbox`)).json.emails as { to: string; subject: string; text: string }[];
  const mail = outbox.find((m) => m.to === "ana@example.com");
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
  check("the code is emailed (captured in the outbox)", !!code && /sign-in code/.test(mail!.subject), mail?.subject);
  check("asking again straight away is limited", (await app("/auth/otp", { email: "ana@example.com" })).status === 429);
  const wrong = code === "000000" ? "111111" : "000000";
  check("a wrong code is refused", (await app("/auth/verify", { email: "ana@example.com", code: wrong })).status === 401);
  const ok = await app("/auth/verify", { email: "ana@example.com", code });
  const okJson = (await ok.json()) as { token: string; user: { email: string } };
  check("the right code signs in and makes the account", ok.status === 200 && okJson.user.email === "ana@example.com" && !!okJson.token);
  check("a code works only once", (await app("/auth/verify", { email: "ana@example.com", code })).status === 401);

  await call(A, { action: "setAuth", auth: { signups: false } });
  const before = ((await call(`/api/projects/${pid}/cloud?view=outbox`)).json.emails as unknown[]).length;
  const closed = await app("/auth/otp", { email: "stranger@example.com" });
  const after = ((await call(`/api/projects/${pid}/cloud?view=outbox`)).json.emails as unknown[]).length;
  check("with sign-up closed, strangers get no code (and aren't told)", closed.status === 200 && after === before);
  await call(A, { action: "setAuth", auth: { signups: true, password: true, allowedDomains: ["acme.com"] } });
  const other = await app("/auth/signup", { email: "bo@example.com", password: "password123" });
  check("only allowed email domains can sign up", other.status === 403 && /@acme\.com/.test(((await other.json()) as { error: string }).error));
  check("and allowed ones can", (await app("/auth/signup", { email: "bo@acme.com", password: "password123" })).status === 201);
  check("bad domains are refused", (await call(A, { action: "setAuth", auth: { allowedDomains: ["not a domain"] } })).status === 400);
  await call(A, { action: "setAuth", auth: { allowedDomains: [] } });

  // ── AI activity
  const chat = await app("/ai/chat", { messages: [{ role: "user", content: "Reply with the single word: pong" }], maxTokens: 16 });
  check("the app's AI answers", chat.status === 200, String(chat.status));
  const runs1 = (await call(`${A}?view=aiRuns`)).json.runs as { model: string; input_tokens: number; credits: number; request: string | null }[];
  check("each AI call is logged with tokens and credits, without bodies", runs1.length === 1 && runs1[0].input_tokens > 0 && runs1[0].credits >= 1 && runs1[0].request === null, JSON.stringify(runs1[0]));
  await call(A, { action: "setAi", logBodies: true });
  await app("/ai/chat", { messages: [{ role: "user", content: "Reply with the single word: ping" }], maxTokens: 16 });
  const runs2 = (await call(`${A}?view=aiRuns`)).json.runs as { request: string | null; response: string | null }[];
  check("with body logging on, prompt and answer are kept", /ping/.test(runs2[0].request ?? "") && !!runs2[0].response);
  const usage = (await call(`${A}?view=settings`)).json.aiUsage as { credits: number; calls: number };
  check("credits this month add up", usage.calls === 2 && usage.credits >= 2, JSON.stringify(usage));
  await call(A, { action: "setAi", creditLimit: 1 });
  const limited = await app("/ai/chat", { messages: [{ role: "user", content: "hi" }], maxTokens: 16 });
  check("the monthly credit limit stops the app's AI", limited.status === 402);
  await call(A, { action: "setAi", creditLimit: null });

  // ── Disable Cloud
  check("disabling needs the project name typed", (await call(A, { action: "disableCloud", confirm: "nope" })).status === 400);
  const off = await call(A, { action: "disableCloud", confirm: "C24 settings" });
  const st = (await call(`/api/projects/${pid}/cloud`)).json as { enabled: boolean };
  check("disabling deletes the backend", off.status === 200 && st.enabled === false);
  check("and the app's API is gone", (await app("/rest/anything")).status === 404);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  await call("/api/workspace/secrets", { action: "delete", name: "C24_SHARED" });
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
