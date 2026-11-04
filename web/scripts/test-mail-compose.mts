/**
 * Gmail-style compose: recipient parsing and checking, the HTML body
 * (sanitized, sent as multipart/alternative with a plain-text part), the
 * friendly 400 for incomplete addresses, and To/Cc/Bcc autocomplete.
 *   Unit checks run on their own. The rest need the server started with
 *   FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token FORGE_GMAIL_API=http://127.0.0.1:4799
 *   (this script mocks Google on :4799 and an SMTP server on :4796), then:
 *   npx tsx scripts/test-mail-compose.mts <devToken> <test-users.json>
 *   GreenMail (see docs/WORKLOG.md 2026-10-26) adds a real SMTP + IMAP round trip; skipped when it isn't running.
 */
import "dotenv/config";
import http from "node:http";
import net from "node:net";
import { simpleParser } from "mailparser";

process.env.FORGE_GOOGLE_TOKEN_URL = "http://127.0.0.1:4799/token";
process.env.FORGE_GMAIL_API = "http://127.0.0.1:4799";
const { checkAddress, checkRecipient, formatRecipient, htmlToText, parseRecipients, problemText, quoteBlock, textToHtml } = await import("../src/lib/mail/compose");
const { cleanOutgoing, recipientsFor, bodyFor } = await import("../src/lib/mail/outgoing");

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const DEV = `authjs.session-token=${token}`;
let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const call = async (p: string, body?: unknown, cookie = DEV) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in a test
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

// ── Unit: recipients
{
  const r = parseRecipients("a@x.com, B <b@y.com>");
  check("a pasted list becomes one recipient each, with names", r.length === 2 && r[0].address === "a@x.com" && r[1].name === "B" && r[1].address === "b@y.com", JSON.stringify(r));
  const q = parseRecipients('"Shah, Priya" <priya@metrofab.test>; max@iotx.test\nops@gtest.dev');
  check("quoted names keep their commas; semicolons and new lines separate", q.length === 3 && q[0].name === "Shah, Priya" && q[2].address === "ops@gtest.dev", JSON.stringify(q));
  const sp = parseRecipients("a@x.com b@y.com Karan k@imbspectral.com");
  check("addresses separated by spaces split too, a name before one names it", sp.length === 3 && sp[1].address === "b@y.com" && sp[2].name === "Karan" && sp[2].address === "k@imbspectral.com", JSON.stringify(sp));
  check("mailto: and capitals in the domain are tidied", parseRecipients("mailto:Sales@IMBSpectral.COM")[0].address === "Sales@imbspectral.com");
  const bad = checkAddress("corporate@imbspectral", ["imbspectral.com", "gmail.com"]);
  check("a domain with no TLD is refused, suggesting the known domain", !bad.ok && bad.reason === "isn't a complete address" && bad.suggestion === "corporate@imbspectral.com", JSON.stringify(bad));
  check("no @ is refused", !checkAddress("karan").ok);
  check("a space is refused", !checkAddress("ka ran@x.com").ok);
  check("a one-letter TLD is refused", !checkAddress("x@y.c").ok);
  check("a trailing dot is refused", !checkAddress("karan@imbspectral.").ok);
  check("double dots are refused", !checkAddress("a..b@x.com").ok);
  check("real addresses pass (subdomains, plus, long TLDs)", ["ok@sub.example.co.uk", "a+tag@x.io", "n.m@company.solutions"].every((a) => checkAddress(a).ok));
  check(
    "the problem reads as a sentence with the suggestion",
    problemText(checkRecipient({ name: null, address: "corporate@imbspectral" }, ["imbspectral.com"])) === "corporate@imbspectral isn't a complete address. Did you mean corporate@imbspectral.com?",
  );
  check("names with commas are quoted in headers", formatRecipient({ name: "Shah, Priya", address: "p@z.in" }) === '"Shah, Priya" <p@z.in>');
  let msg = "";
  try {
    recipientsFor({ to: "corporate@imbspectral, karan@imbspectral" }, ["sales@imbspectral.com"]);
  } catch (e) {
    msg = (e as Error).message;
  }
  check("the server's check names the first bad address", msg === "corporate@imbspectral isn't a complete address. Did you mean corporate@imbspectral.com?", msg);
  const ok = recipientsFor({ to: ["Priya <priya@metrofab.test>"], cc: "max@iotx.test", bcc: [{ name: "Boss", address: "boss@iotx.test" }] });
  check("good recipients come back formatted for the headers", ok.to[0] === '"Priya" <priya@metrofab.test>' && ok.cc[0] === "max@iotx.test" && ok.bcc[0] === '"Boss" <boss@iotx.test>', JSON.stringify(ok));
}

// ── Unit: HTML body
{
  const dirty = `<div onclick="x()">Hi <b>there</b> <font color="#d93025" face="monospace" size="4">red</font></div><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://iotx.test/q">quote</a><ul><li>first</li><li>second</li></ul><blockquote style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex;background:url(https://evil.test/x)">quoted</blockquote><div class="gmail_quote evil">q</div><img src="http://track.test/p.gif"><iframe src="https://x"></iframe>`;
  const clean = cleanOutgoing(dirty);
  check("outgoing HTML loses scripts, handlers, javascript: links and iframes", !/script|onclick|javascript:|iframe/i.test(clean), clean);
  check("and keeps what the editor writes (b, font colour, lists, links)", /<b>there<\/b>/.test(clean) && /<font color="#d93025" face="monospace" size="4">/.test(clean) && /<ul><li>first/.test(clean) && /href="https:\/\/iotx\.test\/q"/.test(clean), clean);
  check("quote styling stays, url() in styles doesn't", /border-left:1px solid rgb\(204,204,204\)/.test(clean) && !/url\(/.test(clean), clean);
  check("only Gmail's own classes are kept", /class="gmail_quote"/.test(clean) && !/evil/.test(clean), clean);
  check("plain-http images are dropped", !/track\.test/.test(clean), clean);
  const text = htmlToText(`<div>Hello <b>Priya</b>,</div><div><br></div><ol><li>Plate</li><li>Bolts</li></ol><ul><li>soon</li></ul><div>See <a href="https://iotx.test/q">the quote</a></div><div class="gmail_quote"><div>On Mon, Priya wrote:<br></div><blockquote>Please quote<br>12 t</blockquote></div>`);
  check("the plain-text part keeps paragraphs, numbers lists and bullets", /^Hello Priya,\n\n1\. Plate\n2\. Bolts\n- soon/.test(text), JSON.stringify(text));
  check("links show their address and quoted mail gets > marks", /the quote \(https:\/\/iotx\.test\/q\)/.test(text) && /> Please quote\n> 12 t/.test(text), JSON.stringify(text));
  check("AI drafts become editor paragraphs, escaped", textToHtml("Dear Priya,\n\nPrice < 5 & more") === "<div>Dear Priya,</div><div><br></div><div>Price &lt; 5 &amp; more</div>");
  const qb = quoteBlock({ date: "2026-10-26T03:30:00Z", fromName: "Priya Shah", fromAddr: "priya@metrofab.test", html: "<p>PO <b>4471</b></p>", text: null });
  check("replies quote the original under an 'On …, … wrote:' line", /class="gmail_quote"/.test(qb) && /Priya Shah &lt;<a href="mailto:priya@metrofab\.test">/.test(qb) && / wrote:<br><\/div><blockquote/.test(qb) && /PO <b>4471<\/b>/.test(qb));
  const b = bodyFor({ html: "<div>Hi <i>x</i></div>", text: "ignored" });
  check("the server makes the text part from the HTML", b.html === "<div>Hi <i>x</i></div>" && b.text === "Hi x", JSON.stringify(b));
  check("text-only clients still work", bodyFor({ text: "plain" }).html === undefined && bodyFor({ text: "plain" }).text === "plain");
}

// ── Against the server
const up = await fetch(`${BASE}/api/workspace`, { headers: { cookie: DEV } }).then((r) => r.ok).catch(() => false);
if (!up || !token) {
  console.log("SKIP server checks — the web server isn't running on :3000 (or no session token given)");
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

const { db } = await import("../src/lib/db");
const { seal } = await import("../src/lib/secret-box");
const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const ws = (await call("/api/workspace")).json.workspace.id as string;

// Mock Gmail
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const RAW = [
  "From: Priya Shah <priya@metrofab.test>",
  "To: compose@gtest.dev",
  "Cc: Ravi Kumar <ravi@metrofab.test>",
  "Subject: PO 4471 for MS plate",
  "Message-ID: <po4471c@metrofab.test>",
  "Date: Mon, 26 Oct 2026 09:00:00 +0530",
  "MIME-Version: 1.0",
  'Content-Type: text/html; charset="utf-8"',
  "",
  "<p>Please find <b>PO 4471</b> for 12 t MS plate.</p>",
].join("\r\n");
const store: Record<string, { labels: string[]; raw: string }> = { c1: { labels: ["INBOX"], raw: RAW } };
const gsent: string[] = [];
const gmail = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  let body = "";
  for await (const ch of req) body += ch;
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  if (u.pathname === "/token") return new URLSearchParams(body).get("refresh_token") === "rt-compose" ? json({ access_token: "at-compose", expires_in: 3600 }) : json({ error: "invalid_grant" }, 400);
  if (req.headers.authorization !== "Bearer at-compose") return json({ error: { message: "Invalid Credentials" } }, 401);
  const path = u.pathname.replace("/gmail/v1/users/me", "");
  if (path === "/labels") return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" }] });
  if (path === "/labels/INBOX") return json({ messagesUnread: 0 });
  if (path === "/messages" && req.method === "GET") return json({ messages: Object.entries(store).filter(([, m]) => m.labels.includes(u.searchParams.get("labelIds") ?? "INBOX")).map(([id]) => ({ id, threadId: id })) });
  if (path === "/messages/send") {
    const raw = Buffer.from(JSON.parse(body).raw, "base64url").toString();
    gsent.push(raw);
    return json({ id: `s${gsent.length}`, threadId: `s${gsent.length}` });
  }
  const m = path.match(/^\/messages\/([^/]+)$/);
  if (m && store[m[1]]) {
    const msg = store[m[1]];
    if (u.searchParams.get("format") === "raw") return json({ id: m[1], raw: b64(msg.raw) });
    if (u.searchParams.get("format") === "minimal") return json({ id: m[1], labelIds: msg.labels });
    const headers = msg.raw.split("\r\n\r\n")[0].split("\r\n").map((l) => ({ name: l.split(":")[0], value: l.slice(l.indexOf(":") + 1).trim() }));
    return json({ id: m[1], threadId: m[1], labelIds: msg.labels, snippet: "Please find PO 4471", internalDate: String(Date.now()), payload: { headers, mimeType: "text/html" } });
  }
  json({ error: { message: "not found" } }, 404);
});
await new Promise<void>((r) => gmail.listen(4799, "127.0.0.1", () => r()));

// Mock SMTP: just enough of the protocol for nodemailer; refuses nobody@… like a real server would.
const smtp: { rcpt: string[]; data: string }[] = [];
const smtpServer = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  let cur = { rcpt: [] as string[], data: "" };
  sock.write("220 mock ESMTP\r\n");
  sock.on("data", (ch) => {
    buf += ch.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        cur.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        smtp.push(cur);
        cur = { rcpt: [], data: "" };
        sock.write("250 queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-mock\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      else if (cmd === "AUTH") sock.write("235 ok\r\n");
      else if (cmd === "MAIL") sock.write("250 ok\r\n");
      else if (cmd === "RCPT") {
        const a = line.match(/<([^>]*)>/)?.[1] ?? "";
        if (a.startsWith("nobody@")) sock.write("550 5.1.1 Recipient address rejected: no such user\r\n");
        else {
          cur.rcpt.push(a);
          sock.write("250 ok\r\n");
        }
      } else if (cmd === "DATA") {
        inData = true;
        sock.write("354 go\r\n");
      } else if (cmd === "QUIT") sock.end("221 bye\r\n");
      else if (cmd === "RSET" || cmd === "NOOP") sock.write("250 ok\r\n");
      else sock.write("502 no\r\n");
    }
  });
  sock.on("error", () => undefined);
});
await new Promise<void>((r) => smtpServer.listen(4796, "127.0.0.1", () => r()));

const EMAILS = ["compose@gtest.dev", "smtp-compose@gtest.dev", "sales@iotx.test"];
await db.mailbox.deleteMany({ where: { workspaceId: ws, email: { in: EMAILS } } });
const common = { workspaceId: ws, ownerId: dev.id, createdById: dev.id, sharedWith: [], status: "ok" };
const gbox = await db.mailbox.create({ data: { ...common, email: "compose@gtest.dev", provider: "google", authType: "gmail", imapHost: "gmail-api", imapPort: 443, smtpHost: "gmail-api", smtpPort: 443, username: "compose@gtest.dev", secret: seal("gmail-refresh", "rt-compose") as never } });
// Nothing listens on the IMAP port: filing the Sent copy fails quietly, as it does when a server is down.
const sbox = await db.mailbox.create({ data: { ...common, email: "smtp-compose@gtest.dev", provider: "custom", imapHost: "127.0.0.1", imapPort: 4795, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 4796, smtpSecure: false, username: "smtp-compose@gtest.dev", secret: seal("mailbox", "pw") as never } });

const HTML = `<div>Hello <b>Priya</b>,</div><div><br></div><ul><li>first</li><li>second</li></ul><div><font color="#d93025">urgent</font> <a href="https://iotx.test/q">quote</a></div><script>alert(1)</script><div onclick="x()">x</div>`;

try {
  // Gmail path
  const list = (await call(`/api/mail?view=messages&mailbox=${gbox.id}&folder=INBOX`)).json.messages as { id: string }[];
  check("the test inbox syncs from the Gmail mock", list?.length === 1, JSON.stringify(list));
  const bad = await call("/api/mail", { action: "send", mailbox: gbox.id, to: "corporate@imbspectral, karan@imbspectral", subject: "x", html: "<div>x</div>" });
  check("an address without a TLD is a 400, not a send", bad.status === 400 && gsent.length === 0, JSON.stringify(bad));
  check("with a message a person understands", /^corporate@imbspectral isn't a complete address\./.test(bad.json.error ?? "") && !/Invalid To header/i.test(bad.json.error ?? ""), bad.json.error);
  const bad2 = await call("/api/mail", { action: "send", mailbox: gbox.id, to: "priya@metrofab.test", cc: "karan", subject: "x", text: "x" });
  check("bad Cc addresses are caught too", bad2.status === 400 && /^karan isn't an email address/.test(bad2.json.error ?? ""), bad2.json.error);
  check("no recipients is a 400", (await call("/api/mail", { action: "send", mailbox: gbox.id, to: "", subject: "x", text: "x" })).status === 400);

  const c = (await call(`/api/mail?view=contacts&mailbox=${gbox.id}`)).json as { contacts: { name: string | null; address: string; member?: boolean }[]; domains: string[] };
  check("autocomplete knows who's in the mail (From and Cc)", c.contacts?.some((x) => x.address === "priya@metrofab.test" && x.name === "Priya Shah") && c.contacts.some((x) => x.address === "ravi@metrofab.test"), JSON.stringify(c).slice(0, 300));
  check("and the workspace's members", c.contacts?.some((x) => x.address === "member@localhost" && x.member), JSON.stringify(c.contacts?.filter((x) => x.member)).slice(0, 300));
  check("but not the mailbox itself", !c.contacts?.some((x) => x.address === "compose@gtest.dev"));
  check("its domains include the mailbox's own", c.domains?.[0] === "gtest.dev" || c.domains?.includes("gtest.dev"), JSON.stringify(c.domains));

  const s = await call("/api/mail", { action: "send", mailbox: gbox.id, to: "Priya Shah <priya@metrofab.test>", cc: "ravi@metrofab.test", bcc: "boss@iotx.test", subject: "Re: PO 4471 for MS plate", html: HTML, replyTo: list[0]?.id });
  const raw = gsent[0] ?? "";
  check("an HTML reply sends through Gmail", s.status === 200 && gsent.length === 1, JSON.stringify(s));
  check("as multipart/alternative with text/plain and text/html parts", /Content-Type: multipart\/alternative/i.test(raw) && /Content-Type: text\/plain/i.test(raw) && /Content-Type: text\/html/i.test(raw), raw.slice(0, 600));
  const p = await simpleParser(raw);
  check("the HTML part is sanitized and keeps the formatting", /<b>Priya<\/b>/.test(String(p.html)) && /<ul><li>first/.test(String(p.html)) && /color="#d93025"/.test(String(p.html)) && !/script|onclick/i.test(String(p.html)), String(p.html));
  check("the text part is readable", /Hello Priya,/.test(p.text ?? "") && /- first\n- second/.test(p.text ?? "") && /quote \(https:\/\/iotx\.test\/q\)/.test(p.text ?? ""), JSON.stringify(p.text));
  check("To keeps the name; Cc and Bcc reach Gmail", /To: Priya Shah <priya@metrofab\.test>/.test(raw) && /Cc: ravi@metrofab\.test/.test(raw) && /Bcc: boss@iotx\.test/.test(raw), raw.slice(0, 500));
  check("and it threads to the original", /In-Reply-To: <po4471c@metrofab\.test>/.test(raw) && /References: <po4471c@metrofab\.test>/.test(raw));
  const legacy = await call("/api/mail", { action: "send", mailbox: gbox.id, to: "priya@metrofab.test", subject: "plain", text: "Just text." });
  check("text-only sends still work", legacy.status === 200 && /Just text\./.test(gsent[1] ?? "") && !/text\/html/i.test(gsent[1] ?? ""));

  // SMTP path (mock server)
  const ss = await call("/api/mail", { action: "send", mailbox: sbox.id, to: "Priya Shah <priya@metrofab.test>", bcc: "boss@iotx.test", subject: "Quote", html: HTML });
  const env = smtp[0];
  check("an HTML send goes out over SMTP", ss.status === 200 && !!env, JSON.stringify(ss));
  check("SMTP: multipart/alternative with both parts", /Content-Type: multipart\/alternative/i.test(env?.data ?? "") && /text\/plain/i.test(env?.data ?? "") && /text\/html/i.test(env?.data ?? ""), env?.data.slice(0, 400));
  const sp = env ? await simpleParser(env.data) : null;
  check("SMTP: sanitized HTML and a text part", /<b>Priya<\/b>/.test(String(sp?.html)) && !/script/i.test(String(sp?.html)) && /- first/.test(sp?.text ?? ""));
  check("SMTP: Bcc gets the mail without appearing in the headers", !!env?.rcpt.includes("boss@iotx.test") && !/^Bcc:/im.test(env?.data ?? ""), JSON.stringify(env?.rcpt));
  const refused = await call("/api/mail", { action: "send", mailbox: sbox.id, to: "nobody@metrofab.test", subject: "x", text: "x" });
  check("a recipient the server refuses gets a plain explanation", refused.status === 400 && /wasn't accepted by the mail server/.test(refused.json.error ?? ""), refused.json.error);

  // GreenMail round trip (optional)
  if (await portOpen(3025)) {
    const gm = await db.mailbox.create({ data: { ...common, email: "sales@iotx.test", provider: "custom", imapHost: "127.0.0.1", imapPort: 3143, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 3025, smtpSecure: false, username: "sales@iotx.test", secret: seal("mailbox", "salespass") as never } });
    const subj = `compose ${Date.now().toString(36)}`;
    const r = await call("/api/mail", { action: "send", mailbox: gm.id, to: "Max <max@iotx.test>", subject: subj, html: HTML });
    const { ImapFlow } = await import("imapflow");
    const c2 = new ImapFlow({ host: "127.0.0.1", port: 3143, secure: false, auth: { user: "max@iotx.test", pass: "maxpass" }, logger: false });
    await c2.connect();
    const lock = await c2.getMailboxLock("INBOX");
    let got = "";
    try {
      for await (const m of c2.fetch("1:*", { source: true, envelope: true })) if (m.envelope?.subject === subj) got = m.source?.toString() ?? "";
    } finally {
      lock.release();
      await c2.logout();
    }
    check("GreenMail: the HTML mail arrives as multipart/alternative", r.status === 200 && /multipart\/alternative/i.test(got) && /text\/html/i.test(got), got.slice(0, 300));
  } else console.log("SKIP GreenMail round trip — nothing on 127.0.0.1:3025 (Docker isn't running); the SMTP path is covered by the mock above");
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  await db.mailbox.deleteMany({ where: { workspaceId: ws, email: { in: EMAILS } } });
  gmail.close();
  smtpServer.close();
  await db.$disconnect();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
