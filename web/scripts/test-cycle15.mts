/**
 * Announcements admin (platform admins via FORGE_ADMIN_EMAILS): create,
 * schedule, edit and delete; others are refused; the dashboard feed shows
 * only live ones. Restores the announcements file afterwards.
 *   npx tsx scripts/test-cycle15.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const FILE = path.join(process.env.PROJECTS_ROOT ?? "", "_forge", "announcements.json");
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const backup = await fs.readFile(FILE, "utf8").catch(() => null);
const call = async (method: string, body?: unknown, who = token, q = "") => {
  const r = await fetch(`${BASE}/api/admin/announcements${q}`, {
    method,
    headers: { cookie: `authjs.session-token=${who}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const feed = async () => ((await (await fetch(`${BASE}/api/announcements`, { headers: { cookie: `authjs.session-token=${users["member@localhost"]}` } })).json()).announcements as { id: string; title: string }[]) ?? [];

try {
  check("a non-admin can't list or write", (await call("GET", undefined, users["member@localhost"])).status === 403 && (await call("POST", { title: "x" }, users["member@localhost"])).status === 403);
  check("validation: title, link and dates", (await call("POST", { title: "" })).status === 400 && (await call("POST", { title: "a", href: "javascript:alert(1)" })).status === 400 && (await call("POST", { title: "a", startsAt: "2026-11-02T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" })).status === 400);
  const live = (await call("POST", { title: "C15 live news", body: "Now on", href: "/help" })).json.announcement as { id: string };
  const later = (await call("POST", { title: "C15 scheduled", startsAt: new Date(Date.now() + 86_400_000).toISOString() })).json.announcement as { id: string };
  const f1 = await feed();
  check("the feed shows the live one, not the scheduled one", f1.some((a) => a.id === live.id) && !f1.some((a) => a.id === later.id));
  const all = (await call("GET")).json.announcements as { id: string }[];
  check("admins see scheduled ones too", all.some((a) => a.id === later.id));
  await call("POST", { id: live.id, title: "C15 live news (edited)", endsAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() - 60_000).toISOString() });
  const f2 = await feed();
  check("editing keeps the id; ending it removes it from the feed", !f2.some((a) => a.id === live.id) && ((await call("GET")).json.announcements as { id: string; title: string }[]).find((a) => a.id === live.id)?.title === "C15 live news (edited)");
  await call("DELETE", undefined, token, `?id=${later.id}`);
  check("delete removes it", !((await call("GET")).json.announcements as { id: string }[]).some((a) => a.id === later.id));
  const page = await fetch(`${BASE}/settings/platform`, { headers: { cookie: `authjs.session-token=${users["member@localhost"]}` } });
  check("the settings page is hidden from non-admins", page.status === 404, String(page.status));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (backup === null) await fs.rm(FILE, { force: true });
  else await fs.writeFile(FILE, backup);
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
