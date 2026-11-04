/**
 * Cloud browser and login vault: public sites only, allowed sites and card
 * approvals, live screenshots and states, take over (agent paused) and hand
 * back, signing in with a saved login without the password reaching the
 * agent or the history, admin switch-off; the user-facing API.
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle35.mts <devToken>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
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
const call = async (p: string, body?: unknown) => {
  const r = await fetchRetry(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any>, raw: r };
};
const B = await import("../src/lib/cloud-browser");
const V = await import("../src/lib/login-vault");
const TP = await import("../src/lib/tool-permissions");
let pid = "";
const ws = (await call("/api/workspace")).json.workspace as { id: string };
const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const before = await B.browserSettings(ws.id);
const err = async (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);

try {
  pid = ((await call("/api/projects", { name: "C35 browser", force: true })).json.project as { id: string }).id;
  await B.saveBrowserSettings(ws.id, { enabled: true, anySite: false, allowed: ["example.com"], idleMinutes: 10 });

  // ── Agent side (the library, as the agent's tools use it)
  check("nothing is open at first", B.browserState(pid).state === "not in use");
  const r1 = await B.openUrl(pid, ws.id, "https://example.com", "agent");
  check("the agent opens an allowed site", /Example Domain/.test(r1.title), r1.title);
  check("and the browser shows as Live", B.browserState(pid).state === "live");
  const priv = await err(B.openUrl(pid, ws.id, "http://127.0.0.1:3000", "agent"));
  check("private addresses are refused", priv instanceof Error && /public websites/.test(priv.message));
  const blocked = await err(B.openUrl(pid, ws.id, "https://the-internet.herokuapp.com/login", "agent"));
  check("other sites need approval", blocked instanceof Error && blocked.message === "NOT_ALLOWED:the-internet.herokuapp.com");
  await TP.approve(ws.id, "connector:browser:the-internet.herokuapp.com", "hour");
  const r2 = await B.openUrl(pid, ws.id, "https://the-internet.herokuapp.com/login", "agent");
  check("once approved, it opens", r2.url.includes("/login"));
  const text = await B.readPage(pid);
  check("the agent can read the page", /Login Page/.test(text.text));

  await V.saveLogin(dev.id, { site: "the-internet.herokuapp.com", username: "tomsmith", password: "SuperSecretPassword!" });
  const listed = await V.listLogins(dev.id);
  check("saved logins never list their password", listed.length >= 1 && !JSON.stringify(listed).includes("SuperSecret"));
  const saved = await V.loginFor(dev.id, "the-internet.herokuapp.com");
  const signedIn = await B.fillLogin(pid, ws.id, saved!.username, saved!.password);
  const after = await B.readPage(pid);
  check("signing in with a saved login works", signedIn.url.includes("/secure") && /secure area/i.test(after.text), signedIn.url);

  await B.takeOver(pid, "dev@localhost");
  const paused = await err(B.act(pid, ws.id, { kind: "press", key: "Tab" }, "agent"));
  check("while the person has control, the agent is paused", paused instanceof Error && /paused/.test(paused.message));
  await B.act(pid, ws.id, { kind: "type", text: "my private note" }, "dev@localhost", false);
  await B.handBack(pid, "dev@localhost");
  check("after handing back, the agent can act again", !(await err(B.act(pid, ws.id, { kind: "scroll", dy: 200 }, "agent"))));
  const hist = await fs.readFile(path.join(ROOT, "_forge", "browser-history", `${pid}.jsonl`), "utf8");
  check("the history records what was done", /take over/.test(hist) && /Signed in to the-internet/.test(hist));
  check("and never a password or what the person typed", !hist.includes("SuperSecretPassword") && !hist.includes("my private note"));
  await B.saveBrowserSettings(ws.id, { enabled: false });
  check("an admin switch-off closes it", B.browserState(pid).state === "not in use");
  const off = await err(B.openUrl(pid, ws.id, "https://example.com", "agent"));
  check("and stops it opening again", off instanceof Error && /switched off/.test(off.message));
  await B.saveBrowserSettings(ws.id, { enabled: true });

  // ── The person's side (the API on the server)
  const open = await call(`/api/projects/${pid}/browser`, { action: "open", url: "example.com" });
  check("people can open a site in the Browser tab", open.status === 200 && /Example/.test(open.json.title ?? ""), JSON.stringify(open.json));
  const shot = await fetchRetry(`${BASE}/api/projects/${pid}/browser?shot=1`, { headers: { cookie } });
  check("the live view is a screenshot", shot.status === 200 && shot.headers.get("content-type") === "image/jpeg");
  check("clicking needs taking over first", (await call(`/api/projects/${pid}/browser`, { action: "click", x: 10, y: 10 })).status === 409);
  await call(`/api/projects/${pid}/browser`, { action: "takeover" });
  check("after taking over, clicks go through", (await call(`/api/projects/${pid}/browser`, { action: "click", x: 100, y: 100 })).status === 200);
  check("its state says who has control", (await call(`/api/projects/${pid}/browser`)).json.controlledBy === "user");
  const h = (await call(`/api/projects/${pid}/browser?history=1`)).json.history as { action: string }[];
  check("the history is available for audit", h.some((x) => x.action === "take over"));
  await call(`/api/projects/${pid}/browser`, { action: "close" });
  check("and it can be closed", (await call(`/api/projects/${pid}/browser`)).json.state === "not in use");

  const vault = await call("/api/account/vault", { action: "save", site: "https://www.app.example.com/login", username: "me", password: "pw-123456" });
  check("the vault page saves a login by site", vault.status === 200 && (vault.json.logins as { site: string }[]).some((l) => l.site === "app.example.com") && !JSON.stringify(vault.json).includes("pw-123456"));
  for (const l of vault.json.logins as { id: string; site: string }[]) if (l.site === "app.example.com") await call("/api/account/vault", { action: "delete", id: l.id });
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  await B.closeBrowser(pid, "test");
  for (const l of await V.listLogins(dev.id)) if (l.site === "the-internet.herokuapp.com") await V.deleteLogin(dev.id, l.id);
  await TP.approve(ws.id, "connector:browser:the-internet.herokuapp.com", "deny");
  await B.saveBrowserSettings(ws.id, before);
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
