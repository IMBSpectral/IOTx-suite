/**
 * In-house Mail against a local test mail server (GreenMail on 127.0.0.1:3025
 * SMTP / 3143 IMAP, users sales@iotx.test and max@iotx.test), plus the Google
 * Drive connection's guards.
 *   Start GreenMail first (see docs/WORKLOG.md 2026-10-26), then:
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle39.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import fs from "node:fs";
import nodemailer from "nodemailer";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const [token, usersFile] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(usersFile, "utf8")) as Record<string, string>;
const DEV = `authjs.session-token=${token}`;
const devWs = (await (await fetch(`${BASE}/api/workspace`, { headers: { cookie: DEV } })).json()).workspace.id as string;
const MEMBER = `authjs.session-token=${users["member@localhost"]}; forge_ws=${devWs}`;
const OUTSIDER = `authjs.session-token=${users["outsider@localhost"]}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown, cookie = DEV) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const local = { provider: "custom", imapHost: "127.0.0.1", imapPort: 3143, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 3025, smtpSecure: false };
const created: string[] = [];
const subject = `C39 quote request ${Date.now().toString(36)}`;
const member = await db.user.findUniqueOrThrow({ where: { email: "member@localhost" } });

try {
  // ── Mailboxes
  const st = (await call("/api/mail/mailboxes")).json;
  check("the owner manages company mailboxes", st.isAdmin === true && Array.isArray(st.all));
  check("a member doesn't", (await call("/api/mail/mailboxes", undefined, MEMBER)).json.isAdmin === false);

  const bad = await call("/api/mail/mailboxes", { action: "add", scope: "shared", email: "sales@iotx.test", password: "wrong", ...local });
  check("a wrong password is refused with a clear message", bad.status === 400 && /rejected|password|sign in/i.test(bad.json.error ?? ""), bad.json.error);
  const add = await call("/api/mail/mailboxes", { action: "add", scope: "shared", email: "sales@iotx.test", displayName: "Sales", password: "salespass", ...local });
  check("a shared mailbox connects after a live test", add.status === 201 && add.json.mailbox?.status === "ok", JSON.stringify(add.json).slice(0, 200));
  const sales = add.json.mailbox?.id as string;
  created.push(sales);
  check("its password never comes back", !JSON.stringify(add.json).includes("salespass") && !("secret" in (add.json.mailbox ?? {})));
  check("a shared mailbox isn't visible to people not given it", !(await call("/api/mail/mailboxes", undefined, MEMBER)).json.mine.some((m: { id: string }) => m.id === sales));
  check("members can't add shared mailboxes", (await call("/api/mail/mailboxes", { action: "add", scope: "shared", email: "x@iotx.test", password: "p", ...local }, MEMBER)).status === 403);
  await call("/api/mail/mailboxes", { action: "share", id: sales, userIds: [member.id] });
  check("once given, the member sees it in Mail", (await call("/api/mail/mailboxes", undefined, MEMBER)).json.mine.some((m: { id: string }) => m.id === sales));
  check("an outsider can't open it", (await call(`/api/mail?view=messages&mailbox=${sales}`, undefined, OUTSIDER)).status === 404);

  // ── Receiving
  await nodemailer.createTransport({ host: "127.0.0.1", port: 3025, secure: false }).sendMail({
    from: "Ravi Kumar <ravi@customer.test>",
    to: "sales@iotx.test",
    subject,
    text: "Hello, please quote 40 tonnes of HR coil 2mm, delivery to Pune by 15 November. Regards, Ravi",
    html: "<p>Hello, please quote <b>40 tonnes</b> of HR coil 2mm, delivery to Pune by 15 November.</p><script>alert(1)</script><p>Regards, Ravi</p>",
    attachments: [{ filename: "specs.txt", content: "Grade: IS 2062 E250" }],
  });
  check("syncing pulls new mail", (await call("/api/mail", { action: "sync", mailbox: sales, folder: "INBOX" }, MEMBER)).status === 200);
  const listed = (await call(`/api/mail?view=messages&mailbox=${sales}&folder=INBOX`, undefined, MEMBER)).json.messages as { id: string; subject: string; seen: boolean; hasAttachments: boolean }[];
  const msg = listed?.find((m) => m.subject === subject);
  check("the message is listed, unread, with its attachment flagged", !!msg && !msg.seen && msg.hasAttachments, JSON.stringify(listed?.slice(0, 2)));
  const found = (await call(`/api/mail?view=messages&mailbox=${sales}&folder=INBOX&q=${encodeURIComponent(subject.slice(4))}`, undefined, MEMBER)).json.messages as { id: string }[];
  check("search finds it", found?.length === 1 && found[0].id === msg?.id);
  const opened = (await call(`/api/mail?view=message&mailbox=${sales}&id=${msg?.id}`, undefined, MEMBER)).json.message;
  check("opening it shows the body", /40 tonnes/.test(opened?.html ?? "") && /HR coil/.test(opened?.text ?? ""));
  check("scripts in mail are removed", !/<script/i.test(opened?.html ?? ""));
  check("and it's marked read", ((await call(`/api/mail?view=messages&mailbox=${sales}&folder=INBOX`, undefined, MEMBER)).json.messages as { id: string; seen: boolean }[]).find((m) => m.id === msg?.id)?.seen === true);
  const part = (opened?.attachments ?? [])[0]?.part;
  const file = await fetch(`${BASE}/api/mail?view=attachment&mailbox=${sales}&id=${msg?.id}&part=${part}`, { headers: { cookie: MEMBER } });
  check("attachments download", file.status === 200 && (await file.text()).includes("IS 2062"));
  const folders = (await call(`/api/mail?view=folders&mailbox=${sales}`, undefined, MEMBER)).json.folders as { path: string; role: string | null }[];
  check("folders are listed with the inbox first", folders?.[0]?.role === "inbox", JSON.stringify(folders));

  // ── Sending
  const sent = await call("/api/mail", { action: "send", mailbox: sales, to: "max@iotx.test", subject: `Re: ${subject}`, text: "Thanks Ravi, quote attached shortly.", replyTo: msg?.id }, MEMBER);
  check("sending works through the mailbox's own server", sent.status === 200 && !!sent.json.messageId, JSON.stringify(sent.json));
  check("a send with no recipient is refused", (await call("/api/mail", { action: "send", mailbox: sales, to: "", subject: "x", text: "x" }, MEMBER)).status === 400);

  // ── Personal mailbox
  const mine = await call("/api/mail/mailboxes", { action: "add", scope: "mine", email: "max@iotx.test", password: "maxpass", ...local }, MEMBER);
  check("a member connects their own mailbox", mine.status === 201, JSON.stringify(mine.json).slice(0, 200));
  const maxBox = mine.json.mailbox?.id as string;
  created.push(maxBox);
  await call("/api/mail", { action: "sync", mailbox: maxBox, folder: "INBOX" }, MEMBER);
  const inbox = (await call(`/api/mail?view=messages&mailbox=${maxBox}&folder=INBOX`, undefined, MEMBER)).json.messages as { subject: string }[];
  check("the reply arrived in the other mailbox", inbox?.some((m) => m.subject === `Re: ${subject}`), JSON.stringify(inbox?.map((m) => m.subject)));
  check("personal mailboxes stay private from other members' Mail", !(await call("/api/mail/mailboxes")).json.mine.some((m: { id: string }) => m.id === maxBox));
  check("admins see every mailbox in settings", (await call("/api/mail/mailboxes")).json.all.some((m: { id: string }) => m.id === maxBox));
  check("only the owner or an admin can disconnect it", (await call("/api/mail/mailboxes", { action: "remove", id: sales }, MEMBER)).status === 403);

  // ── AI
  const sum = await call("/api/mail", { action: "summarize", mailbox: sales, id: msg?.id }, MEMBER);
  check("AI summarizes a message", sum.status === 200 && /40|coil|quote/i.test(sum.json.summary ?? ""), (sum.json.summary ?? sum.json.error ?? "").slice(0, 120));
  const lab = await call("/api/mail", { action: "classify", mailbox: sales, id: msg?.id }, MEMBER);
  check("and labels it as an enquiry or quotation", lab.status === 200 && ["enquiry", "quotation"].includes(lab.json.label), lab.json.label);

  // ── Google guards (no real Google account in tests)
  const g = (await call("/api/google?view=status")).json;
  check("Google status reports whether it's set up", typeof g.configured === "boolean" && g.connection === null);
  check("files need a Drive connection first", (await call("/api/google?view=files&kind=sheets")).status === 400);
  const go = await fetch(`${BASE}/api/google/connect?back=/sheets`, { headers: { cookie: DEV }, redirect: "manual" });
  const loc = go.headers.get("location") ?? "";
  check("connecting asks Google for Drive and Sheets access", !g.configured || (/accounts\.google\.com/.test(loc) && /auth\/drive([ +&]|$)/.test(decodeURIComponent(loc)) && /auth\/spreadsheets([ +&]|$)/.test(decodeURIComponent(loc)) && /access_type=offline/.test(loc)), loc.slice(0, 120));
  check("an unlinked sheet can't be read by an app", (await fetch(`${BASE}/api/live-sheet/nope/abc`)).status === 404);
  check("a forged callback is refused", ((await fetch(`${BASE}/api/google/callback?state=x.y&code=z`, { headers: { cookie: DEV }, redirect: "manual" })).headers.get("location") ?? "").includes("google_error"));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (created.length) await db.mailbox.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
