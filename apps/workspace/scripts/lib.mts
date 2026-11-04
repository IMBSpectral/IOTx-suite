/**
 * Shared test helpers. Every script takes the suite dev session token and the
 * test-users file:  npx tsx scripts/test-x.mts <devToken> <path/to/test-users.json>
 */
import fs from "node:fs";

export const SUITE = process.env.SUITE ?? "http://localhost:3000";
export const WS = process.env.WS ?? "http://localhost:3100/workspace";
export const WS_ORIGIN = new URL(WS).origin;

export function envOf(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const [devToken, usersPath] = process.argv.slice(2);
if (!devToken || !usersPath) {
  console.error("usage: npx tsx scripts/<test>.mts <devToken> <test-users.json>");
  process.exit(2);
}
const users = JSON.parse(fs.readFileSync(usersPath, "utf8")) as Record<string, string>;
export const OWNER = `authjs.session-token=${devToken}`;
export const OUTSIDER = `authjs.session-token=${users["outsider@localhost"]}`;
export let MEMBER = `authjs.session-token=${users["member@localhost"]}`;

let failures = 0, passes = 0;
export function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
export function summary(label: string) {
  console.log(`\n${label}: ${passes} passed, ${failures} failed`);
  return failures;
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Res = { status: number; json: any; headers: Headers };

/** A call to the suite (cookie = suite session cookie). */
export async function suite(p: string, body?: unknown, cookie = OWNER, method?: string): Promise<Res> {
  const r = await fetch(`${SUITE}${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
}

/** A call to Workspace (cookie = Workspace session cookie). */
export async function ws(p: string, body?: unknown, cookie = "", method?: string): Promise<Res> {
  const r = await fetch(`${WS}/api${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
}

let _lastSet = "";
export const lastSetCookie = () => _lastSet;

/** Get a pass from the suite (as that suite user) and trade it for a Workspace session cookie. */
export async function signIn(suiteCookie: string, app = "calendar", tz = "Asia/Kolkata"): Promise<string> {
  const cb = `${WS}/auth/callback?next=/calendar`;
  const r = await fetch(`${SUITE}/api/iotx/pass?app=${app}&redirect=${encodeURIComponent(cb)}`, { headers: { cookie: suiteCookie }, redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  const m = /#iotx_pass=(.+)$/.exec(loc);
  if (!m) throw new Error(`no pass (status ${r.status}) ${(await r.text()).slice(0, 200)}`);
  const s = await fetch(`${WS}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pass: m[1], tz }) });
  const set = s.headers.get("set-cookie") ?? "";
  _lastSet = set;
  const c = /iotx_ws_session=([^;]+)/.exec(set);
  if (!c) throw new Error(`no session (status ${s.status})`);
  return `iotx_ws_session=${c[1]}`;
}

/** The dev owner's workspace, and the member cookie pinned to it. */
export async function setup() {
  const w = (await suite("/api/workspace")).json.workspace as { id: string };
  MEMBER = `${MEMBER}; forge_ws=${w.id}`;
  return { wsId: w.id, MEMBER };
}

/** Suite permission admin: the built-in Member role. */
export async function memberRoleId() {
  const st = (await suite("/api/permissions?admin=1")).json as { roles: { id: string; builtin: string | null }[] };
  return st.roles.find((r) => r.builtin === "member")!.id;
}
export async function setMemberPerm(set: Record<string, boolean>) {
  const id = await memberRoleId();
  return suite("/api/permissions", { action: "updateRole", roleId: id, set });
}
export async function resetMember() {
  const id = await memberRoleId();
  return suite("/api/permissions", { action: "resetRole", roleId: id });
}

/** Monday 00:00 UTC of a week some weeks from now. */
export function nextMonday(weeksAhead = 1) {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 7 * weeksAhead));
}
