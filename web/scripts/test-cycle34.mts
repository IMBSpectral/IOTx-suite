/**
 * Git maintenance (commit attribution, branches, large files in history,
 * history clean-up with confirmation) and member management (seat cap,
 * invite links by role with limits, role-upgrade requests through the action
 * center, groups shared onto a project, member profiles).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle34.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
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
const call = async (p: string, body?: unknown, c = cookie) => {
  const r = await fetchRetry(`${BASE}${p}`, body === undefined ? { headers: { cookie: c } } : { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any>, headers: r.headers };
};
let pid = "";
const ws = (await call("/api/workspace")).json.workspace as { id: string };
const outsiderUser = await db.user.findUniqueOrThrow({ where: { email: "outsider@localhost" } });
const linkTokens: string[] = [];

try {
  // ── Git maintenance
  pid = ((await call("/api/projects", { name: "C34 git", force: true })).json.project as { id: string }).id;
  const repo = await import("../src/lib/repo");
  const git = (await import("isomorphic-git")).default;
  const nodeFs = (await import("node:fs")).default;
  const { repoDir } = await import("../src/lib/paths");
  await repo.writeFiles(pid, [{ path: "big.bin", content: "x".repeat(1_500_000) }]);
  await repo.commit(pid, "Add a big file", { name: "Dev Person", email: "dev@localhost" });
  await repo.deleteFile(pid, "big.bin");
  await repo.writeFiles(pid, [{ path: "src/notes.md", content: "hello" }]);
  const sha = await repo.commit(pid, "Remove it", { name: "Dev Person", email: "dev@localhost" });
  const c = await git.readCommit({ fs: nodeFs, dir: repoDir(pid), oid: sha });
  check("versions are credited to the member, with the project named", c.commit.author.email === "dev@localhost" && c.commit.message.includes(`Forge-Project: ${pid}`));
  const br = (await call(`/api/projects/${pid}/git`)).json as { branches: { name: string; stale: boolean }[] };
  check("branches are listed, and main is never stale", br.branches.some((b) => b.name === "main" && !b.stale));
  const large = (await call(`/api/projects/${pid}/git?large=1`)).json.files as { path: string; inCurrent: boolean }[];
  check("large files in history are found, even deleted ones", large.some((f) => f.path === "big.bin" && !f.inCurrent));
  check("cleaning up history needs the project name", (await call(`/api/projects/${pid}/git`, { action: "cleanHistory", confirm: "nope" })).status === 400);
  const cleaned = await call(`/api/projects/${pid}/git`, { action: "cleanHistory", confirm: "C34 git" });
  check("history starts again from the current version", cleaned.status === 200 && cleaned.json.after === 1 && cleaned.json.before >= 3, JSON.stringify(cleaned.json));
  check("and the large file is gone from it", ((await call(`/api/projects/${pid}/git?large=1`)).json.files as unknown[]).length === 0);
  check("the current files are untouched", (await repo.readFile(pid, "src/notes.md")) === "hello");

  // ── Seat cap
  const seats = ((await call("/api/workspace/members-extra")).json.seats as number) ?? 0;
  await call("/api/workspace/members-extra", { action: "seatCap", cap: seats });
  const blocked = await call("/api/workspace/members", { email: "c34-new@example.com", role: "MEMBER" });
  check("at the seat cap, new invites are refused", blocked.status === 403 && /seat cap/.test(blocked.json.error), JSON.stringify(blocked.json));
  await call("/api/workspace/members-extra", { action: "seatCap", cap: seats + 5 });

  // ── Invite links
  const link = (await call("/api/workspace/members-extra", { action: "createLink", role: "VIEWER", expiresInDays: 7, maxUses: 1 })).json as { token: string; url: string };
  linkTokens.push(link.token);
  const page = await (await fetchRetry(link.url, { headers: { cookie: `authjs.session-token=${users["outsider@localhost"]}` } })).text();
  check("an invite link page names the workspace and role", page.includes("Join ") && page.includes("a viewer"));
  const joined = await call("/api/workspace/members-extra", { action: "join", token: link.token }, `authjs.session-token=${users["outsider@localhost"]}`);
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: outsiderUser.id, workspaceId: ws.id } } });
  check("joining with it adds the person with the link's role", joined.status === 200 && m?.role === "VIEWER");
  check("a link with one use can't be used again", (await call("/api/workspace/members-extra", { action: "join", token: link.token }, `authjs.session-token=${users["member@localhost"]}`)).status === 410);

  // ── Role request (the outsider switches into this workspace first)
  const sw = await call("/api/workspace/switch", { workspaceId: ws.id }, `authjs.session-token=${users["outsider@localhost"]}`);
  const wsCookie = (sw.headers.get("set-cookie") ?? "").split(";")[0];
  const outsiderInWs = `authjs.session-token=${users["outsider@localhost"]}; ${wsCookie}`;
  check("you can't ask for your own role", (await call("/api/workspace/members-extra", { action: "requestRole", to: "VIEWER" }, outsiderInWs)).status === 400);
  const req = await call("/api/workspace/members-extra", { action: "requestRole", to: "MEMBER", reason: "I need to build the pricing page" }, outsiderInWs);
  check("a viewer can ask to become a member", req.status === 201);
  const ac = (await call("/api/workspace/action-center")).json.approvals as { id: string; type: string }[];
  const ask = ac.find((a) => a.type === "role");
  check("the request shows in the action center", !!ask);
  await call("/api/workspace/members-extra", { action: "decideRole", id: ask!.id, approve: true });
  check("approving it changes their role", (await db.membership.findUnique({ where: { userId_workspaceId: { userId: outsiderUser.id, workspaceId: ws.id } } }))?.role === "MEMBER");

  // ── Groups and profiles
  await call("/api/workspace/members-extra", { action: "saveGroup", name: "C34 Pricing team", members: [outsiderUser.id] });
  const g = ((await call("/api/workspace/members-extra")).json.groups as { id: string; name: string }[]).find((x) => x.name === "C34 Pricing team")!;
  const shared = await call("/api/workspace/members-extra", { action: "shareGroup", groupId: g.id, projectId: pid, access: "edit" });
  const collab = await db.collaborator.findUnique({ where: { projectId_userId: { projectId: pid, userId: outsiderUser.id } } });
  check("a project can be shared with a whole group", shared.status === 200 && collab?.role === "MEMBER");
  const prof = (await call(`/api/workspace/members-extra?profile=${outsiderUser.id}`)).json as { role: string; collaborations: { id: string }[]; groups: string[] };
  check("a member's profile shows their role, collaborations and groups", prof.role === "MEMBER" && prof.collaborations.some((c2) => c2.id === pid) && prof.groups.includes("C34 Pricing team"));
  await call("/api/workspace/members-extra", { action: "deleteGroup", id: g.id });
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const t of linkTokens) await call("/api/workspace/members-extra", { action: "revokeLink", token: t });
  await call("/api/workspace/members-extra", { action: "seatCap", cap: null });
  await db.membership.deleteMany({ where: { userId: outsiderUser.id, workspaceId: ws.id } });
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
