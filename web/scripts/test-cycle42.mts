/**
 * Sign in with an emailed link, invitation-only still applying to it, and
 * built apps sending email through a company shared mailbox.
 * Needs: the server started with FORGE_EMAIL_SIGNIN=on and
 * FORGE_SIGNUP_ALLOW=@localhost, and GreenMail running (iotx-greenmail on
 * 127.0.0.1:3025 / 3143, user sales@iotx.test / salespass).
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle42.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const ROOT = process.env.PROJECTS_ROOT!;
const [token] = process.argv.slice(2);
const DEV = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown, cookie = DEV) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const outbox = path.join(ROOT, "_forge", "outbox.jsonl");
const outboxLines = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, "utf8").trim().split("\n").filter(Boolean) : []);

/** Ask for a sign-in link the way the browser does (CSRF token + form post). Returns the response location. */
async function requestLink(email: string) {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const jar = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const r = await fetch(`${BASE}/api/auth/signin/email`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: jar, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, callbackUrl: "/home" }),
  });
  return r.headers.get("location") ?? "";
}

let pid = "";
let boxId = "";
try {
  // ── Email sign-in link
  const before = outboxLines().length;
  const loc = await requestLink("dev@localhost");
  const sent = outboxLines().slice(before).map((l) => JSON.parse(l) as { to: string; subject: string; text: string });
  const mail = sent.find((m) => m.to === "dev@localhost");
  // Auth.js answers with its own verify-request step, which forwards to ours.
  const step = await fetch(new URL(loc, BASE), { redirect: "manual" });
  const step2 = await fetch(new URL(step.headers.get("location") ?? "/", BASE), { redirect: "manual" });
  const finalLoc = step2.headers.get("location") ?? "";
  check("asking for a link ends on the check-your-email message", finalLoc === "/login?check=email" || finalLoc.endsWith("/login?check=email"), `${loc} -> ${step.headers.get("location")} -> ${finalLoc}`);
  check("a sign-in email is sent, branded", !!mail && /sign-in link/i.test(mail.subject), mail?.subject);
  const link = mail?.text.match(/https?:\/\/\S+\/api\/auth\/callback\/email\?\S+/)?.[0] ?? "";
  check("it contains a one-time link", !!link, link.slice(0, 80));
  const cb = await fetch(link.replace(/^https?:\/\/[^/]+/, BASE), { redirect: "manual" });
  const session = (cb.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("authjs.session-token="))?.split(";")[0] ?? "";
  check("opening the link signs you in", !!session && (await call("/api/workspace", undefined, session)).status === 200);
  const again = await fetch(link.replace(/^https?:\/\/[^/]+/, BASE), { redirect: "manual" });
  check("the link only works once", !(again.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("authjs.session-token=")), again.headers.get("location") ?? "");

  const b2 = outboxLines().length;
  const blocked = await requestLink("stranger@not-invited.test");
  check("invitation-only still applies: no link for an uninvited new address", blocked.includes("signup_closed") && !outboxLines().slice(b2).some((l) => l.includes("stranger@not-invited.test")), blocked);
  check("and no account is created", !(await db.user.findUnique({ where: { email: "stranger@not-invited.test" } })));

  // ── Built apps sending through a company mailbox
  const added = await call("/api/mail/mailboxes", { action: "add", scope: "shared", email: "sales@iotx.test", displayName: "Sales", password: "salespass", provider: "custom", imapHost: "127.0.0.1", imapPort: 3143, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 3025, smtpSecure: false });
  boxId = added.json.mailbox?.id ?? (await db.mailbox.findFirst({ where: { email: "sales@iotx.test" } }))?.id ?? "";
  check("a shared company mailbox is connected", !!boxId, JSON.stringify(added.json).slice(0, 160));
  pid = ((await call("/api/projects", { name: "C42 app mail", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { cloudHealth } = await import("../src/lib/cloud-ops");
  const senders = (await cloudHealth(pid)).email.senders as { id: string }[];
  check("the app offers the shared mailbox as a sender", senders.some((s) => s.id === boxId), JSON.stringify(senders));
  const bad = await call(`/api/projects/${pid}/cloud`, { action: "features", mailboxId: "not-a-mailbox" });
  check("only the workspace's shared mailboxes can be chosen", bad.status === 400);
  const ok = await call(`/api/projects/${pid}/cloud`, { action: "features", mailboxId: boxId, fromName: "Inventory app" });
  check("choosing the mailbox is saved", ok.status === 200);
  const { getCloud } = await import("../src/lib/cloud");
  const { deliver } = await import("../src/lib/cloud-ops");
  const cfg = await getCloud(pid);
  const subject = `C42 low stock ${Date.now().toString(36)}`;
  const result = await deliver(pid, cfg!, { to: "sales@iotx.test", subject, text: "HR coil 2mm is below 10 t.", html: null }, "dev@localhost");
  check("the app's email is sent through the mailbox", result.status === "sent", result.error ?? "");
  const imap = new ImapFlow({ host: "127.0.0.1", port: 3143, secure: false, auth: { user: "sales@iotx.test", pass: "salespass" }, logger: false });
  await imap.connect();
  const lock = await imap.getMailboxLock("INBOX");
  let found = false;
  try {
    for await (const msg of imap.fetch("1:*", { envelope: true })) if (msg.envelope?.subject === subject) found = /Inventory app/.test(msg.envelope.from?.[0]?.name ?? "") && msg.envelope.from?.[0]?.address === "sales@iotx.test";
  } finally {
    lock.release();
    await imap.logout();
  }
  check("and arrives from the company's own address with the app's name", found);
  await call(`/api/projects/${pid}/cloud`, { action: "features", mailboxId: null });
  check("the sender can be cleared", (await getCloud(pid))?.email?.mailboxId === null);

  // ── Database export by emailed link
  const b3 = outboxLines().length;
  const ex = await call(`/api/projects/${pid}/cloud/admin`, { action: "emailExport" });
  const exMail = outboxLines().slice(b3).map((l) => JSON.parse(l) as { to: string; text: string }).find((m) => m.to === "dev@localhost");
  const exLink = exMail?.text.match(/https?:\/\/\S+\/api\/cloud-export\/\S+/)?.[0] ?? "";
  check("an export link is emailed to the person asking", ex.status === 200 && ex.json.sentTo === "dev@localhost" && !!exLink, JSON.stringify(ex.json));
  const dl = await fetch(exLink.replace(/^https?:\/\/[^/]+/, BASE));
  const head = Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString();
  check("the link downloads the database", dl.status === 200 && head === "SQLite format 3", head);
  check("a tampered link is refused", (await fetch(exLink.replace(/^https?:\/\/[^/]+/, BASE).replace(/sig=[^&]+/, "sig=forged"))).status === 404);
  check("an expired link is refused", (await fetch(exLink.replace(/^https?:\/\/[^/]+/, BASE).replace(/exp=\d+/, `exp=${Date.now() - 1000}`))).status === 404);
  check("people without access can't ask for one", (await call(`/api/projects/${pid}/cloud/admin`, { action: "emailExport" }, `authjs.session-token=${JSON.parse(fs.readFileSync(process.argv[3], "utf8"))["outsider@localhost"]}`)).status >= 400);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie: DEV } });
  if (boxId) await db.mailbox.deleteMany({ where: { id: boxId } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
