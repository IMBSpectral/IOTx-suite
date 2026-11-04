/**
 * Billing over HTTP as the owner (dev) and a workspace MEMBER: usage split,
 * spending limits (workspace / member / project) with admin vs member
 * messages, top-up, auto top-up, plans, ownership transfer, settings search.
 *   npx tsx scripts/test-billing.mts <devToken> <usersJsonPath>
 */
import fs from "node:fs";
import { searchSettings } from "../src/components/SettingsSearch";

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
const extraCookie: Partial<Record<Who, string>> = {};
async function as(who: Who, path: string, json?: unknown, method = json === undefined ? "GET" : "POST") {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: `authjs.session-token=${tokens[who]}${extraCookie[who] ? `; ${extraCookie[who]}` : ""}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body };
}
const billing = (who: Who = "dev") => as(who, "/api/workspace/billing");

async function main() {
  const start = (await billing()).body;
  // The member's first workspace is their own; switch into the dev workspace.
  const devWs = (await as("dev", "/api/workspace")).body.workspace.id;
  check("can't switch into a stranger's workspace", (await as("member", "/api/workspace/switch", { workspaceId: "nope" })).status === 403);
  const sw = await fetch(BASE + "/api/workspace/switch", {
    method: "POST",
    headers: { cookie: `authjs.session-token=${tokens.member}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: devWs }),
  });
  extraCookie.member = (sw.headers.get("set-cookie") ?? "").split(";")[0];
  check("member switches workspace", sw.status === 200 && (await as("member", "/api/workspace")).body.workspace.id === devWs);
  check("owner sees billing as admin", start.isAdmin === true);
  check("usage split has categories", typeof start.usage.byCategory === "object" && start.usage.daily.length === 30,
    JSON.stringify(start.usage.byCategory));
  check("member sees billing, not admin", (await billing("member")).body.isAdmin === false);
  check("member can't top up", (await as("member", "/api/workspace/billing", { action: "topup", amount: 50 })).status === 403);

  // Top-up.
  await as("dev", "/api/workspace/billing", { action: "topup", amount: 50 });
  const afterTop = (await billing()).body;
  check("top-up adds credits", afterTop.balance === start.balance + 50, `${start.balance} -> ${afterTop.balance}`);
  check("odd top-up refused", (await as("dev", "/api/workspace/billing", { action: "topup", amount: 7 })).status === 400);

  // A project that already spent credits this month.
  const spentProject = start.usage.byProject.find((p: any) => p.id && p.credits > 0);
  check("a project has spend this month", !!spentProject, JSON.stringify(start.usage.byProject.slice(0, 2)));
  if (spentProject) {
    const pid = spentProject.id;
    await as("dev", "/api/workspace/billing", { action: "setLimit", scope: "project", targetId: pid, monthly: 1 });
    const limited = (await billing()).body.limits.find((l: any) => l.targetId === pid);
    check("project limit listed with spend", limited?.monthly === 1 && limited.spent >= 1, JSON.stringify(limited));
    const ownerSend = await as("dev", `/api/projects/${pid}/messages`, { content: "limit test", mode: "ask" });
    check("owner blocked by project limit", ownerSend.status === 402 && ownerSend.body.scope === "project", JSON.stringify(ownerSend.body));
    check("owner told to raise it", /Manage limits/.test(ownerSend.body.hint ?? ""));
    const memberSend = await as("member", `/api/projects/${pid}/messages`, { content: "limit test", mode: "ask" });
    check("member told to ask an admin", memberSend.status === 402 && /Ask a workspace owner or admin/.test(memberSend.body.hint ?? ""),
      `${memberSend.status} ${JSON.stringify(memberSend.body).slice(0, 120)}`);
    await as("dev", "/api/workspace/billing", { action: "removeLimit", id: limited.id });
    check("limit removed", !(await billing()).body.limits.some((l: any) => l.id === limited.id));

    // Workspace limit below this month's spend.
    await as("dev", "/api/workspace/billing", { action: "workspaceLimit", monthly: 1 });
    const wsSend = await as("dev", `/api/projects/${pid}/messages`, { content: "limit test", mode: "ask" });
    check("workspace limit blocks", wsSend.status === 402 && wsSend.body.scope === "workspace");
    await as("dev", "/api/workspace/billing", { action: "workspaceLimit", monthly: start.workspaceLimit });
    check("workspace limit restored", (await billing()).body.workspaceLimit === start.workspaceLimit);

    // Member limit.
    const memberId = start.members.find((m: any) => m.name === "Max Member")?.id;
    const set = await as("dev", "/api/workspace/billing", { action: "setLimit", scope: "user", targetId: memberId, monthly: 5 });
    check("member limit set", set.status === 200);
    const lim = (await billing()).body.limits.find((l: any) => l.targetId === memberId);
    check("member limit listed", lim?.name === "Max Member" && lim.spent === 0);
    await as("dev", "/api/workspace/billing", { action: "removeLimit", id: lim.id });
    check("limit for outsider refused", (await as("dev", "/api/workspace/billing", { action: "setLimit", scope: "user", targetId: "nobody", monthly: 5 })).status === 404);

    // Ownership transfer.
    check("member can't transfer", (await as("member", "/api/projects/bulk", { action: "transfer", ids: [pid], ownerId: memberId })).status === 403);
    await as("dev", "/api/projects/bulk", { action: "transfer", ids: [pid], ownerId: memberId });
    const mine = (await as("member", "/api/projects?view=mine")).body.projects;
    check("transfer makes member the owner", mine.some((p: any) => p.id === pid));
    const devId = start.members.find((m: any) => m.name !== "Max Member")?.id;
    await as("dev", "/api/projects/bulk", { action: "transfer", ids: [pid], ownerId: devId });
    check("transfer to non-member refused", (await as("dev", "/api/projects/bulk", { action: "transfer", ids: [pid], ownerId: "nobody" })).status === 400);
    check("move to a workspace you don't admin refused",
      (await as("dev", "/api/projects/bulk", { action: "moveWorkspace", ids: [pid], workspaceId: "nope" })).status === 403);
  }

  // Auto top-up and plans.
  // Auto top-up is metered: the usage terms are accepted once per workspace.
  const unaccepted = await as("dev", "/api/workspace/billing", { action: "autoTopup", on: true, amount: 100 });
  check("auto top-up needs the usage terms (or they were accepted before)", unaccepted.status === 409 || unaccepted.status === 200);
  await as("dev", "/api/workspace/billing", { action: "autoTopup", on: true, amount: 100, acceptTerms: true });
  check("auto top-up on", (await billing()).body.autoTopup.on === true);
  await as("dev", "/api/workspace/billing", { action: "autoTopup", on: start.autoTopup.on, amount: start.autoTopup.amount || 100 });
  await as("dev", "/api/workspace/billing", { action: "plan", plan: "PRO" });
  const pro = (await billing()).body;
  check("plan switch", pro.plan === "PRO" && pro.monthlyCredits === 500);
  await as("dev", "/api/workspace/billing", { action: "plan", plan: start.plan });

  // Settings search.
  check("search: spending limit", searchSettings("spending limit").results[0]?.title === "Spending limits");
  const fuzzy = searchSettings("limit banana");
  check("search: closest results notice", !fuzzy.exact && fuzzy.results.some((r) => r.title === "Spending limits"));

  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
