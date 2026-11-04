/**
 * Sharing end to end over HTTP, as three people: the owner (dev), a workspace
 * MEMBER and an outsider. Usage:
 *   npx tsx scripts/test-sharing.mts <devToken> <usersJsonPath>
 */
import fs from "node:fs";
import http from "node:http";

/** fetch() drops a custom Host header; preview links are routed by host. */
function hostReq(host: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: 3000, path, method: opts.method ?? "GET", headers: { host, ...(opts.headers ?? {}) } },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const BASE = "http://localhost:3000";
const [devToken, usersPath] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(usersPath, "utf8").replace(/^﻿/, ""));
const tokens = { dev: devToken, member: users["member@localhost"], outsider: users["outsider@localhost"] };
type Who = keyof typeof tokens;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function as(who: Who, path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { cookie: `authjs.session-token=${tokens[who]}` };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, {
    ...init,
    redirect: "manual",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  // A fresh project owned by dev.
  const created = await as("dev", "/api/projects", { method: "POST", json: { name: `Share test ${Date.now()}`, force: true } });
  const pid = created.body.project.id as string;
  const P = `/api/projects/${pid}`;
  try {
    // Workspace member can open it; outsider can't.
    check("member can view workspace project", (await as("member", `${P}/share`)).status === 200);
    check("outsider gets 403", (await as("outsider", `${P}/share`)).status === 403);
    check("unknown project gets 404", (await as("dev", `/api/projects/nope/share`)).status === 404);
    check("unauthenticated gets 401", (await fetch(BASE + `${P}/share`)).status === 401);

    // Restricted hides it from the member.
    check("restrict", (await as("dev", `${P}/share`, { method: "PATCH", json: { restricted: true } })).status === 200);
    check("member blocked when restricted", (await as("member", `${P}/share`)).status === 403);
    const memberList = await as("member", "/api/projects?view=all");
    check("restricted hidden from member's list", !memberList.body.projects.some((p: any) => p.id === pid));
    const memberSearch = await as("member", `/api/search?q=Share%20test`);
    check("restricted hidden from member's search", !memberSearch.body.projects.some((p: any) => p.id === pid));
    check("member can't bulk-delete it", (await as("member", "/api/projects/bulk", { method: "POST", json: { action: "delete", ids: [pid] } })).body.count !== 1);

    // Outsider requests access; dev is notified and approves as view.
    const req = await as("outsider", `${P}/access-requests`, { method: "POST", json: { kind: "view", message: "Client here" } });
    check("outsider requests access", req.status === 201);
    const notes = await as("dev", "/api/notifications");
    check("owner notified of request", notes.body.items.some((n: any) => n.kind === "access_request"));
    let share = await as("dev", `${P}/share`);
    check("request listed for owner", share.body.requests.length === 1 && share.body.requests[0].message === "Client here");
    await as("dev", `${P}/access-requests`, { method: "PATCH", json: { requestId: share.body.requests[0].id, decision: "approve" } });
    share = await as("outsider", `${P}/share`);
    check("outsider now views", share.status === 200 && share.body.access === "view");
    check("outsider can't edit", (await as("outsider", `${P}/files`, { method: "PUT", json: { path: "x.txt", content: "x" } })).status === 403);
    check("outsider can't send build", (await as("outsider", `${P}/messages`, { method: "POST", json: { content: "hi" } })).status === 403);
    const out = await as("outsider", "/api/notifications");
    check("outsider notified of approval", out.body.items.some((n: any) => n.kind === "access_approved"));
    const owner = await as("dev", `${P}/share`);
    check("outsider flagged external", owner.body.collaborators.some((c: any) => c.email === "outsider@localhost" && c.external));

    // Request to edit, then decline all.
    check("request to edit", (await as("outsider", `${P}/access-requests`, { method: "POST", json: { kind: "edit" } })).status === 201);
    const dec = await as("dev", `${P}/access-requests`, { method: "PATCH", json: { declineAll: true } });
    check("decline all", dec.body.count === 1);
    check("still view after decline", (await as("outsider", `${P}/share`)).body.access === "view");

    // Role change to edit via PATCH.
    const collabId = owner.body.collaborators.find((c: any) => c.email === "outsider@localhost").id;
    await as("dev", `${P}/collaborators`, { method: "PATCH", json: { collaboratorId: collabId, role: "MEMBER" } });
    check("role change to edit", (await as("outsider", `${P}/share`)).body.access === "edit");
    check("editor still can't manage", (await as("outsider", `${P}/share`, { method: "PATCH", json: { restricted: false } })).status === 403);

    // Leave.
    check("outsider leaves", (await as("outsider", `${P}/leave`, { method: "POST" })).status === 200);
    check("gone after leaving", (await as("outsider", `${P}/share`)).status === 403);

    // Invite link: member joins a restricted project as editor.
    await as("dev", `${P}/share`, { method: "PATCH", json: { inviteLink: "edit" } });
    share = await as("dev", `${P}/share`);
    const joinPath = new URL(share.body.inviteLink.url).pathname;
    const join = await as("member", joinPath);
    check("join redirects into project", [302, 303, 307].includes(join.status) || (join.status === 200 && String(join.body).includes(pid)), `status ${join.status}`);
    check("member can edit via link", (await as("member", `${P}/share`)).body.access === "edit");
    await as("dev", `${P}/share`, { method: "PATCH", json: { resetInviteLink: true } });
    const old = await as("outsider", joinPath);
    check("reset link stops old link", old.status === 200 && String(old.body).includes("isn&#x27;t active") || String(old.body).includes("active"), `status ${old.status}`);
    check("outsider still no access after dead link", (await as("outsider", `${P}/share`)).status === 403);

    // Preview links.
    const mk = await as("dev", `${P}/preview-links`, { method: "POST", json: { name: "Client review", expires: "24h", password: "hunter22" } });
    check("create preview link", mk.status === 201 && /^http:\/\/preview--[a-z0-9]+\.localhost/.test(mk.body.url), mk.body.url);
    check("short password refused", (await as("dev", `${P}/preview-links`, { method: "POST", json: { name: "x", password: "123" } })).status === 400);
    const host = new URL(mk.body.url).host;
    const gate = await hostReq(host, "/");
    check("password gate shown", gate.text.includes("password protected"), `status ${gate.status}`);
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const bad = await hostReq(host, "/__forge/unlock", { method: "POST", headers: form, body: "password=nope" });
    check("wrong password refused", bad.status === 401);
    const good = await hostReq(host, "/__forge/unlock", { method: "POST", headers: form, body: "password=hunter22" });
    const cookie = String(good.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    check("right password unlocks", good.status === 303 && cookie.startsWith("forge_preview_link="));
    const page = await hostReq(host, "/", { headers: { cookie } });
    const html = page.text;
    check("preview serves the built app", page.status === 200 && html.includes('<div id="root">') && html.includes("noindex"), `status ${page.status} ${html.slice(0, 160)}`);
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    if (asset) check("preview serves assets", (await hostReq(host, asset, { headers: { cookie } })).status === 200, asset);
    const list = await as("dev", `${P}/share`);
    const link = list.body.previewLinks.find((l: any) => l.name === "Client review");
    check("views counted", link?.views >= 1, `views ${link?.views}`);
    await as("dev", `${P}/preview-links?linkId=${link.id}`, { method: "DELETE" });
    const revoked = await hostReq(host, "/", { headers: { cookie } });
    check("revoked link returns 410", revoked.status === 410);
  } finally {
    await as("dev", "/api/projects/bulk", { method: "POST", json: { action: "delete", ids: [pid] } });
    await as("dev", "/api/projects/bulk", { method: "POST", json: { action: "purge", ids: [pid] } });
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
