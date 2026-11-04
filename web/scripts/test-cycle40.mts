/**
 * "Sign in with Google" mailboxes, against a mock of Google's token endpoint
 * and the Gmail API on 127.0.0.1:4799. Start the server with
 *   FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token FORGE_GMAIL_API=http://127.0.0.1:4799
 * then: PROJECTS_ROOT=... npx tsx scripts/test-cycle40.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";

process.env.FORGE_GOOGLE_TOKEN_URL = "http://127.0.0.1:4799/token";
process.env.FORGE_GMAIL_API = "http://127.0.0.1:4799";
const { db } = await import("../src/lib/db");

const BASE = "http://localhost:3000";
const [token, usersFile] = process.argv.slice(2);
const users = JSON.parse(fs.readFileSync(usersFile, "utf8")) as Record<string, string>;
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

// ── Mock Google
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const idToken = (email: string) => `${b64("{}")}.${b64(JSON.stringify({ email }))}.sig`;
const RAW = [
  "From: Priya Shah <priya@metrofab.test>",
  "To: ops@gtest.dev",
  "Subject: PO 4471 for MS plate",
  "Message-ID: <po4471@metrofab.test>",
  "Date: Mon, 26 Oct 2026 09:00:00 +0530",
  "MIME-Version: 1.0",
  'Content-Type: text/html; charset="utf-8"',
  "",
  "<p>Please find <b>PO 4471</b> for 12 t MS plate.</p><script>alert(1)</script>",
].join("\r\n");
const store: Record<string, { labels: string[]; raw: string }> = { m1: { labels: ["INBOX", "UNREAD"], raw: RAW } };
const sent: string[] = [];
let lastAuth = "";
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  let body = "";
  for await (const ch of req) body += ch;
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  if (u.pathname === "/token") {
    const p = new URLSearchParams(body);
    if (p.get("grant_type") === "refresh_token") return p.get("refresh_token") === "rt-ops" ? json({ access_token: "at-ops", expires_in: 3600 }) : json({ error: "invalid_grant" }, 400);
    if (p.get("code") === "good") return json({ access_token: "at-ops", refresh_token: "rt-ops", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.modify", id_token: idToken("ops@gtest.dev") });
    if (p.get("code") === "noscope") return json({ access_token: "x", refresh_token: "y", scope: "openid email", id_token: idToken("ops@gtest.dev") });
    return json({ error: "invalid_grant" }, 400);
  }
  lastAuth = req.headers.authorization ?? "";
  if (lastAuth !== "Bearer at-ops") return json({ error: { message: "Invalid Credentials" } }, 401);
  const path = u.pathname.replace("/gmail/v1/users/me", "");
  if (path === "/labels") return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" }, { id: "TRASH", name: "TRASH", type: "system" }, { id: "Label_1", name: "Vendors", type: "user" }] });
  if (path === "/labels/INBOX") return json({ messagesUnread: Object.values(store).filter((m) => m.labels.includes("UNREAD")).length });
  if (path === "/messages" && req.method === "GET") {
    const label = u.searchParams.get("labelIds") ?? "INBOX";
    return json({ messages: Object.entries(store).filter(([, m]) => m.labels.includes(label)).map(([id]) => ({ id, threadId: id })) });
  }
  if (path === "/messages/send") {
    const raw = Buffer.from(JSON.parse(body).raw, "base64url").toString();
    sent.push(raw);
    const id = `s${sent.length}`;
    store[id] = { labels: ["SENT"], raw };
    return json({ id, threadId: id });
  }
  const m = path.match(/^\/messages\/([^/]+)(\/modify|\/attachments\/([^/]+))?$/);
  if (m && store[m[1]]) {
    const msg = store[m[1]];
    if (m[2] === "/modify") {
      const d = JSON.parse(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
      msg.labels = [...msg.labels.filter((l) => !d.removeLabelIds?.includes(l)), ...(d.addLabelIds ?? [])];
      return json({ id: m[1], labelIds: msg.labels });
    }
    if (m[3]) return json({ data: b64("Grade: IS 2062 E250"), size: 19 });
    const fmt = u.searchParams.get("format");
    if (fmt === "raw") return json({ id: m[1], raw: b64(msg.raw) });
    if (fmt === "minimal") return json({ id: m[1], labelIds: msg.labels });
    const headers = msg.raw.split("\r\n\r\n")[0].split("\r\n").map((l) => ({ name: l.split(":")[0], value: l.slice(l.indexOf(":") + 1).trim() }));
    return json({ id: m[1], threadId: m[1], labelIds: msg.labels, snippet: "Please find PO 4471", internalDate: String(Date.now()), payload: { headers, mimeType: "multipart/mixed", parts: [{ partId: "0", mimeType: "text/html" }, { partId: "1", mimeType: "text/plain", filename: "specs.txt", body: { attachmentId: "att1", size: 19 } }] } });
  }
  json({ error: { message: "not found" } }, 404);
});
await new Promise<void>((r) => mock.listen(4799, "127.0.0.1", () => r()));

async function connect(code: string, scope = "shared", cookie = DEV) {
  const start = await fetch(`${BASE}/api/mail/google?scope=${scope}&back=/settings/mailboxes`, { headers: { cookie }, redirect: "manual" });
  const loc = start.headers.get("location") ?? "";
  const state = new URL(loc, BASE).searchParams.get("state");
  if (!state) return { loc, end: loc };
  const back = await fetch(`${BASE}/api/google/callback?state=${encodeURIComponent(state)}&code=${code}`, { headers: { cookie }, redirect: "manual" });
  return { loc, end: back.headers.get("location") ?? "" };
}

let boxId = "";
try {
  const first = await connect("good");
  check("Sign in with Google asks for Gmail access and lets you pick the account", /accounts\.google\.com/.test(first.loc) && /gmail\.modify/.test(decodeURIComponent(first.loc)) && /select_account/.test(decodeURIComponent(first.loc)), first.loc.slice(0, 160));
  check("coming back connects the mailbox", first.end.includes("mail=connected"), first.end);
  boxId = new URL(first.end, BASE).searchParams.get("mailbox") ?? "";
  const box = await db.mailbox.findUnique({ where: { id: boxId } });
  check("it's a Google mailbox for the address Google signed in as", box?.authType === "gmail" && box.email === "ops@gtest.dev" && box.ownerId === null);
  check("the refresh token is stored sealed", !!box && !JSON.stringify(box.secret).includes("rt-ops"));
  await call("/api/mail/mailboxes", { action: "share", id: boxId, userIds: [(await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } })).id] });

  const folders = (await call(`/api/mail?view=folders&mailbox=${boxId}`)).json.folders as { path: string; name: string; unseen?: number }[];
  check("Gmail labels become folders, inbox first", folders?.[0]?.path === "INBOX" && folders.some((f) => f.name === "Vendors") && folders[0].unseen === 1, JSON.stringify(folders));
  const list = (await call(`/api/mail?view=messages&mailbox=${boxId}&folder=INBOX`)).json.messages as { id: string; subject: string; seen: boolean; hasAttachments: boolean; fromName: string }[];
  const msg = list?.[0];
  check("inbox syncs through the Gmail API", msg?.subject === "PO 4471 for MS plate" && msg.fromName === "Priya Shah" && !msg.seen && msg.hasAttachments, JSON.stringify(list));
  const opened = (await call(`/api/mail?view=message&mailbox=${boxId}&id=${msg?.id}`)).json.message;
  check("opening it shows the body, scripts removed", /PO 4471/.test(opened?.html ?? "") && !/<script/i.test(opened?.html ?? ""));
  check("and marks it read in Gmail", !store.m1.labels.includes("UNREAD"));
  const file = await fetch(`${BASE}/api/mail?view=attachment&mailbox=${boxId}&id=${msg?.id}&part=att1`, { headers: { cookie: DEV } });
  check("attachments download", file.status === 200 && (await file.text()).includes("IS 2062"));
  const s = await call("/api/mail", { action: "send", mailbox: boxId, to: "priya@metrofab.test", subject: "Re: PO 4471 for MS plate", text: "Received, thank you.", replyTo: msg?.id });
  check("replies send through Gmail, threaded to the original", s.status === 200 && sent.length === 1 && /To: priya@metrofab\.test/.test(sent[0]) && /In-Reply-To: <po4471@metrofab\.test>/.test(sent[0]), sent[0]?.slice(0, 300));
  check("password changes are refused for Google mailboxes", (await call("/api/mail/mailboxes", { action: "update", id: boxId, password: "x" })).status === 400);

  const again = await connect("good");
  check("connecting the same address again reconnects it, no duplicate", again.end.includes(`mailbox=${boxId}`) && (await db.mailbox.count({ where: { email: "ops@gtest.dev" } })) === 1);
  check("without Gmail access granted, it explains", (await connect("noscope")).end.includes("mail_error"));
  const devWs = (await call("/api/workspace")).json.workspace.id as string;
  const member = `authjs.session-token=${users["member@localhost"]}; forge_ws=${devWs}`;
  const blocked = await fetch(`${BASE}/api/mail/google?scope=shared&back=/mail`, { headers: { cookie: member }, redirect: "manual" });
  check("members can't connect shared mailboxes", (blocked.headers.get("location") ?? "").includes("mail_error"));

  // System email through the Google mailbox
  process.env.FORGE_SYSTEM_MAILBOX = "ops@gtest.dev";
  const { sendPlatformEmail } = await import("../src/lib/platform-email");
  const st = await sendPlatformEmail({ to: "newhire@customer.test", subject: "Welcome to IOTx Suite", text: "Your account is ready." });
  check("system emails go out through the Google mailbox", st === "sent" && sent.some((r) => /To: newhire@customer\.test/.test(r)), st);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (boxId) await db.mailbox.deleteMany({ where: { email: "ops@gtest.dev" } });
  mock.close();
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
