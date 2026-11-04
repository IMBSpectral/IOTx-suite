/**
 * Comments over HTTP: threads, replies, mentions, reactions, edit/delete
 * rules, resolve, unread/read, and guest comments through a preview link.
 *   npx tsx scripts/test-comments.mts <devToken> <usersJsonPath>
 */
import fs from "node:fs";
import http from "node:http";

const BASE = "http://localhost:3000";
const [devToken, usersPath] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(usersPath, "utf8").replace(/^﻿/, ""));
const tokens = { dev: devToken, member: users["member@localhost"] };
type Who = keyof typeof tokens;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function as(who: Who, path: string, json?: unknown, method = json === undefined ? "GET" : "POST") {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: `authjs.session-token=${tokens[who]}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body };
}
function hostReq(host: string, path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: 3000, path, method: opts.method ?? "GET", headers: { host, ...(opts.headers ?? {}) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function main() {
  const created = await as("dev", "/api/projects", { name: `Comments test ${Date.now()}`, force: true });
  const pid = created.body.project.id as string;
  const C = `/api/projects/${pid}/comments`;
  try {
    // The member must be in the dev workspace (switcher) to see the project.
    const devWs = (await as("dev", "/api/workspace")).body.workspace.id;
    const sw = await fetch(BASE + "/api/workspace/switch", {
      method: "POST",
      headers: { cookie: `authjs.session-token=${tokens.member}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: devWs }),
    });
    check("member switched", sw.status === 200);

    const t = await as("dev", C, { body: "Make this heading bigger @max", locator: "body > div:nth-of-type(1) > h1:nth-of-type(1)", selector: "h1", elementText: "Hello" });
    check("thread created", t.status === 201);
    const tid = t.body.id;
    check("empty comment refused", (await as("dev", C, { body: "  " })).status === 400);
    const memberNotes = (await as("member", "/api/notifications")).body.items;
    check("@mention notifies member", memberNotes.some((n: any) => n.kind === "comment" && n.href.includes(tid)));
    let list = (await as("member", C)).body;
    check("unread for member", list.unread >= 1 && list.threads[0].unread === true);
    check("pin data kept", list.threads[0].locator.startsWith("body > div") && list.threads[0].selector === "h1");

    const r = await as("member", C, { body: "Agreed, and bold", parentId: tid });
    check("reply", r.status === 201);
    check("reply to reply refused", (await as("member", C, { body: "x", parentId: r.body.id })).status === 404);
    const devNotes = (await as("dev", "/api/notifications")).body.items;
    check("thread author notified of reply", devNotes.some((n: any) => n.kind === "comment" && n.body?.includes("Agreed")));

    check("can't edit others' comment", (await as("dev", `${C}/${r.body.id}`, { body: "hacked" }, "PATCH")).status === 403);
    check("edit own", (await as("member", `${C}/${r.body.id}`, { body: "Agreed, and bolder" }, "PATCH")).status === 200);
    await as("member", `${C}/${tid}`, { react: "👍" }, "PATCH");
    await as("dev", `${C}/${tid}`, { react: "👍" }, "PATCH");
    check("bad reaction refused", (await as("dev", `${C}/${tid}`, { react: "💩" }, "PATCH")).status === 400);
    list = (await as("dev", C)).body;
    const th = list.threads[0];
    check("reactions counted", th.reactions.find((x: any) => x.emoji === "👍")?.count === 2 && th.reactions[0].mine);
    check("edited flag", th.replies[0].editedAt !== null && th.replies[0].body === "Agreed, and bolder");

    await as("member", C, { action: "read" });
    check("mark all read", (await as("member", C)).body.unread === 0);

    check("resolve", (await as("dev", `${C}/${tid}`, { resolved: true }, "PATCH")).status === 200);
    check("resolved excluded from unread", (await as("dev", C)).body.threads[0].resolvedAt !== null);
    check("can't resolve a reply", (await as("dev", `${C}/${r.body.id}`, { resolved: true }, "PATCH")).status === 400);
    await as("dev", `${C}/${tid}`, { resolved: false }, "PATCH");

    // Guest comments through a preview link.
    const off = await as("dev", `/api/projects/${pid}/preview-links`, { name: "No comments" });
    const offHost = new URL(off.body.url).host;
    const offPost = await hostReq(offHost, "/__forge/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "G", body: "hi" }) });
    check("guest comments off by default", offPost.status === 403);
    const on = await as("dev", `/api/projects/${pid}/preview-links`, { name: "Client review", allowComments: true });
    const host = new URL(on.body.url).host;
    check("widget script served", (await hostReq(host, "/__forge/comments.js")).text.includes("Leave a comment"));
    check("widget absent when off", (await hostReq(offHost, "/__forge/comments.js")).status === 404);
    const g = await hostReq(host, "/__forge/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Clara Client", body: "Logo looks blurry", locator: "body > img:nth-of-type(1)", selector: "img", text: "" }),
    });
    check("guest comment accepted", g.status === 201, g.text);
    check("guest needs name", (await hostReq(host, "/__forge/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "x" }) })).status === 400);
    list = (await as("dev", C)).body;
    const guest = list.threads.find((x: any) => x.author.guest);
    check("guest thread visible", guest?.author.name === "Clara Client" && guest.author.via === "Client review" && guest.unread);

    check("delete own thread", (await as("dev", `${C}/${tid}`, undefined, "DELETE")).status === 200);
    list = (await as("dev", C)).body;
    check("thread and replies gone", !list.threads.some((x: any) => x.id === tid));
    check("outsider can't read", (await fetch(BASE + C)).status === 401);
  } finally {
    await as("dev", "/api/projects/bulk", { action: "delete", ids: [pid] });
    await as("dev", "/api/projects/bulk", { action: "purge", ids: [pid] });
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
