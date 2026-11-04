/**
 * Personal skills, workspace announcements (members see them, countdown),
 * account preferences and the public profile (username rules, private
 * profiles hidden, LinkedIn), daily ideas (made once a day, hide, off), and
 * agent test users (made once, reused, can sign in).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle25.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
const memberCookie = `authjs.session-token=${users["member@localhost"]}`;
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
const call = async (p: string, body?: unknown, c = cookie, method?: string) => {
  const r = await fetchRetry(`${BASE}${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie: c, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
let pid = "";
let annId = "";
const before = (await call("/api/account")).json.profile as { handle: string | null; public: boolean; linkedinUrl: string | null };

try {
  // ── Personal skills
  const sk = await call("/api/workspace/skills", { action: "save", scope: "personal", name: "c25-mine", title: "Mine", instructions: "Always use British spelling in UI copy." });
  const lists = (await call("/api/workspace/skills")).json as { skills: { name: string }[]; personal: { name: string; id: string }[] };
  check("a personal skill is saved apart from the workspace's", sk.status === 200 && lists.personal.some((s) => s.name === "c25-mine") && !lists.skills.some((s) => s.name === "c25-mine"));
  const other = (await call("/api/workspace/skills", undefined, memberCookie)).json as { personal: { name: string }[] };
  check("nobody else sees it", !other.personal.some((s) => s.name === "c25-mine"));
  await call("/api/workspace/skills", { action: "delete", scope: "personal", id: lists.personal.find((s) => s.name === "c25-mine")!.id });

  // ── Workspace announcements
  const ends = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const ann = await call("/api/workspace/announcements", { title: "C25 maintenance", body: "Saturday 10:00", endsAt: ends, countdown: true, href: "/help" });
  annId = ann.json.announcement?.id;
  check("a workspace admin can post a banner with a countdown", ann.status === 201 && ann.json.announcement.countdown === true);
  check("bad links are refused", (await call("/api/workspace/announcements", { title: "x", href: "javascript:alert(1)" })).status === 400);
  const seen = (await call("/api/announcements")).json.announcements as { id: string; scope?: string }[];
  check("workspace members see it, marked as the workspace's", seen.some((a) => a.id === annId && a.scope === "workspace"));
  const outsiderSees = (await call("/api/announcements", undefined, memberCookie)).json.announcements as { id: string }[];
  check("people in other workspaces don't", !outsiderSees.some((a) => a.id === annId));

  // ── Preferences and profile
  check("suggestion settings are validated", (await call("/api/account", { action: "prefs", suggestions: "sometimes" })).status === 400);
  await call("/api/account", { action: "prefs", suggestions: "first", on: true });
  const prefs = (await call("/api/account")).json.prefs as { suggestions: string; sandboxDiagnostics: boolean };
  check("suggestions and diagnostics are saved on the account", prefs.suggestions === "first" && prefs.sandboxDiagnostics === true);
  await call("/api/account", { action: "prefs", suggestions: "all", on: false });
  check("usernames are validated", (await call("/api/account", { action: "profile", handle: "a b" })).status === 400);
  const handle = `c25-${Date.now().toString(36)}`;
  await call("/api/account", { action: "profile", handle: `@${handle}`, linkedinUrl: "https://www.linkedin.com/in/c25-test" });
  const page = await fetchRetry(`${BASE}/@${handle}`);
  const html = await page.text();
  check("the public profile shows the username and LinkedIn", page.status === 200 && html.includes(`@${handle}`) && html.includes("linkedin.com/in/c25-test"));
  check("a taken username is refused", (await call("/api/account", { action: "profile", handle }, memberCookie)).status === 409);
  check("LinkedIn must be a profile address", (await call("/api/account", { action: "profile", linkedinUrl: "https://evil.example/in/x" })).status === 400);
  await call("/api/account", { action: "profile", public: false });
  check("a private profile can't be opened", (await fetchRetry(`${BASE}/@${handle}`)).status === 404);

  // ── Daily ideas
  pid = ((await call("/api/projects", { name: "C25 recipe box", description: "Save and search family recipes", force: true })).json.project as { id: string }).id;
  const i1 = (await call(`/api/projects/${pid}/idea`)).json as { idea: { title: string; prompt: string } | null };
  check("a project gets a daily idea with a prompt to send", !!i1.idea?.title && !!i1.idea?.prompt, JSON.stringify(i1.idea));
  const i2 = (await call(`/api/projects/${pid}/idea`)).json as { idea: { title: string } | null };
  check("it stays the same for the day", i2.idea?.title === i1.idea?.title);
  await call(`/api/projects/${pid}/idea`, { action: "dismiss" });
  check("hiding it hides it for today", (await call(`/api/projects/${pid}/idea`)).json.idea === null);
  await call(`/api/projects/${pid}/idea`, { action: "off" });
  check("ideas can be turned off for a project", (await call(`/api/projects/${pid}/idea`)).json.off === true);
  check("people outside the workspace can't read ideas", [403, 404].includes((await call(`/api/projects/${pid}/idea`, undefined, `authjs.session-token=${users["outsider@localhost"]}`)).status));

  // ── Test users (the agent's tool, through the library)
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { ensureTestUser } = await import("../src/lib/cloud-test-users");
  const a = await ensureTestUser(pid, "tester");
  const b = await ensureTestUser(pid, "tester");
  check("a test user is made once and reused", a.created && !b.created && a.email === b.email && a.password === b.password);
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const login = await fetchRetry(`${BASE}/cloud/v1/${pid}/auth/login`, {
    method: "POST",
    headers: { apikey: anonKey, "user-agent": UA, "content-type": "application/json" },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  check("and can sign in to the app", login.status === 200);
  const c = await ensureTestUser(pid, "teammate");
  check("separate labels are separate people", c.email !== a.email);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  await call("/api/account", { action: "profile", handle: before.handle ?? "", public: before.public, linkedinUrl: before.linkedinUrl ?? "" });
  if (annId) await call(`/api/workspace/announcements?id=${annId}`, undefined, cookie, "DELETE");
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
