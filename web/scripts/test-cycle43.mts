/**
 * "Continue with Google" for the users of apps built with the Builder,
 * against a mock Google token endpoint on 127.0.0.1:4799. Start the server
 * with FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token, then:
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle43.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import http from "node:http";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const DEV = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie: DEV } } : { method: "POST", headers: { cookie: DEV, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};

// Mock Google: code "good" → a verified address, "unverified" → email_verified false.
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const ch of req) body += ch;
  const p = new URLSearchParams(body);
  const json = (v: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  if (req.url !== "/token") return json({ error: "not found" }, 404);
  const verified = p.get("code") !== "unverified";
  if (!["good", "unverified"].includes(p.get("code") ?? "")) return json({ error: "invalid_grant" }, 400);
  json({ access_token: "x", expires_in: 3600, scope: "openid email profile", id_token: `${b64("{}")}.${b64(JSON.stringify({ email: "Asha.Rao@Customer.test", email_verified: verified }))}.sig` });
});
await new Promise<void>((r) => mock.listen(4799, "127.0.0.1", () => r()));

let pid = "";
try {
  pid = ((await call("/api/projects", { name: "C43 google sign-in", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const sub = (await db.project.findUniqueOrThrow({ where: { id: pid }, select: { subdomain: true } })).subdomain;
  const site = `http://${sub}.localhost:3000`;
  const start = (redirect: string, state = "s1") => fetch(`${BASE}/cloud/v1/${pid}/auth/google?redirect_uri=${encodeURIComponent(redirect)}&state=${state}`, { headers: { apikey: anonKey }, redirect: "manual" });

  check("it's off until the app turns it on", (await start(`${site}/`)).status === 403);
  const on = await call(`/api/projects/${pid}/cloud/admin`, { action: "setAuth", auth: { google: true } });
  check("the builder can turn on Continue with Google", on.status === 200 && on.json.auth?.google === true, JSON.stringify(on.json));
  check("a return address outside the app is refused", (await start("https://evil.example/steal")).status === 400);

  const go = await start(`${site}/login`);
  const loc = go.headers.get("location") ?? "";
  check("starting sends the person to Google for name and email only", go.status === 302 && /accounts\.google\.com/.test(loc) && /scope=openid\+email\+profile/.test(loc) && !/drive|gmail/.test(loc), loc.slice(0, 140));
  const state = new URL(loc).searchParams.get("state") ?? "";

  const back = await fetch(`${BASE}/api/google/callback?state=${encodeURIComponent(state)}&code=good`, { redirect: "manual" });
  const toApp = new URL(back.headers.get("location") ?? "http://x/");
  check("Google's answer returns the person to the app with a one-time code", toApp.origin === site && toApp.pathname === "/login" && /^fgc_/.test(toApp.searchParams.get("forge_code") ?? "") && toApp.searchParams.get("state") === "s1", toApp.toString().slice(0, 140));
  const code = toApp.searchParams.get("forge_code") ?? "";
  const ex = await fetch(`${BASE}/cloud/v1/${pid}/auth/forge`, { method: "POST", headers: { apikey: anonKey, "content-type": "application/json", origin: site }, body: JSON.stringify({ code }) });
  const sess = (await ex.json().catch(() => ({}))) as { token?: string; user?: { email: string } };
  check("the app trades the code for a session as that Google address", ex.status === 200 && !!sess.token && sess.user?.email === "asha.rao@customer.test", JSON.stringify(sess).slice(0, 140));
  const again = await fetch(`${BASE}/cloud/v1/${pid}/auth/forge`, { method: "POST", headers: { apikey: anonKey, "content-type": "application/json", origin: site }, body: JSON.stringify({ code }) });
  check("the code works only once", again.status === 401);

  const g2 = new URL((await start(`${site}/login`, "s2")).headers.get("location") ?? "").searchParams.get("state") ?? "";
  const unv = new URL((await fetch(`${BASE}/api/google/callback?state=${encodeURIComponent(g2)}&code=unverified`, { redirect: "manual" })).headers.get("location") ?? "http://x/");
  check("an unconfirmed Google address is refused with a message for the app", !!unv.searchParams.get("forge_error") && !unv.searchParams.get("forge_code"), unv.searchParams.get("forge_error") ?? "");

  const g3 = new URL((await start(`${site}/login`, "s3")).headers.get("location") ?? "").searchParams.get("state") ?? "";
  const cancel = new URL((await fetch(`${BASE}/api/google/callback?state=${encodeURIComponent(g3)}&error=access_denied`, { redirect: "manual" })).headers.get("location") ?? "http://x/");
  check("cancelling on Google's screen comes back as a clear message", /cancelled/i.test(cancel.searchParams.get("forge_error") ?? ""));

  await call(`/api/projects/${pid}/cloud/admin`, { action: "setAuth", auth: { allowedDomains: ["mycompany.test"] } });
  const g4 = new URL((await start(`${site}/login`, "s4")).headers.get("location") ?? "").searchParams.get("state") ?? "";
  const c4 = new URL((await fetch(`${BASE}/api/google/callback?state=${encodeURIComponent(g4)}&code=good`, { redirect: "manual" })).headers.get("location") ?? "http://x/").searchParams.get("forge_code") ?? "";
  const ex4 = await fetch(`${BASE}/cloud/v1/${pid}/auth/forge`, { method: "POST", headers: { apikey: anonKey, "content-type": "application/json", origin: site }, body: JSON.stringify({ code: c4 }) });
  check("the app's allowed-domains rule still applies", ex4.status === 403);

  const src = (await db.project.findUnique({ where: { id: pid } })) ? (await import("node:fs")).readFileSync(`${process.env.PROJECTS_ROOT}/${pid}/src/integrations/cloud/client.ts`, "utf8") : "";
  check("the app's Cloud client has signInWithGoogle()", /signInWithGoogle\(\)/.test(src) && !/Generated by Forge/.test(src));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  mock.close();
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie: DEV } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
