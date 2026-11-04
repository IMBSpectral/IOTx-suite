/**
 * A branded sending domain for an app's emails (I.28), against a mock Resend
 * API on 127.0.0.1:4797: add a domain and get its DNS records, verify, switch
 * the sender, send from name@domain, delivery status, the hourly limit, and
 * removal. Start the server with FORGE_RESEND_API=http://127.0.0.1:4797, then:
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle45.mts <devToken>
 */
import "dotenv/config";
import http from "node:http";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const DEV = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie: DEV } } : { method: "POST", headers: { cookie: DEV, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};

// ── Mock Resend ────────────────────────────────────────────────────────────
type MockDomain = { id: string; name: string; status: string; verifyCalls: number };
const domains = new Map<string, MockDomain>();
const sent: { id: string; from: string; to: string; auth: string }[] = [];
const records = (d: MockDomain) => [
  { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: d.status === "verified" ? "verified" : "pending", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
  { record: "SPF", name: "send", type: "TXT", ttl: "Auto", status: d.status === "verified" ? "verified" : "pending", value: "v=spf1 include:amazonses.com ~all" },
  { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: d.status === "verified" ? "verified" : "pending", value: "p=MIGfMA0GCSqGSIb3DQEB" },
];
const mock = http.createServer(async (req, res) => {
  let raw = "";
  for await (const ch of req) raw += ch;
  const body = raw ? JSON.parse(raw) : {};
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  const auth = req.headers.authorization ?? "";
  if (auth !== "Bearer re_test_key") return json({ message: "API key is invalid" }, 401);
  const url = req.url ?? "";
  let m: RegExpMatchArray | null;
  if (req.method === "POST" && url === "/domains") {
    if (body.name === "taken.example") return json({ message: "Domain already registered by another account" }, 422);
    const d = { id: `dom_${domains.size + 1}`, name: body.name, status: "not_started", verifyCalls: 0 };
    domains.set(d.id, d);
    return json({ id: d.id, name: d.name, status: d.status, region: "us-east-1", records: records(d) });
  }
  if ((m = url.match(/^\/domains\/([^/]+)\/verify$/)) && req.method === "POST") {
    const d = domains.get(m[1]);
    if (!d) return json({ message: "not found" }, 404);
    // The first verify is still pending; the second succeeds (DNS "propagated").
    d.verifyCalls++;
    d.status = d.verifyCalls >= 2 ? "verified" : "pending";
    return json({ object: "domain", id: d.id });
  }
  if ((m = url.match(/^\/domains\/([^/]+)$/))) {
    const d = domains.get(m[1]);
    if (!d) return json({ message: "not found" }, 404);
    if (req.method === "DELETE") {
      domains.delete(d.id);
      return json({ object: "domain", id: d.id, deleted: true });
    }
    return json({ id: d.id, name: d.name, status: d.status, region: "us-east-1", records: records(d) });
  }
  if (req.method === "POST" && url === "/emails") {
    const e = { id: `em_${sent.length + 1}`, from: body.from, to: body.to, auth };
    sent.push(e);
    return json({ id: e.id });
  }
  if ((m = url.match(/^\/emails\/([^/]+)$/))) return json({ id: m[1], last_event: m[1] === "em_1" ? "delivered" : "bounced" });
  json({ message: "not found" }, 404);
});
await new Promise<void>((r) => mock.listen(4797, "127.0.0.1", () => r()));

let pid = "";
try {
  pid = ((await call("/api/projects", { name: "C45 email domain", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const cloud = (p: Record<string, unknown>) => call(`/api/projects/${pid}/cloud`, p);
  const dom = (p: Record<string, unknown>) => cloud({ action: "emailDomain", ...p });

  const noKey = await dom({ op: "add", domain: "mail.acme-test.dev" });
  check("adding a domain asks for the Resend key first", noKey.status === 400 && /RESEND_API_KEY/.test(noKey.json.error ?? ""), noKey.json.error);
  await cloud({ action: "setSecret", name: "RESEND_API_KEY", value: "re_test_key" });
  await cloud({ action: "features", fromName: "Acme Orders" });

  check("a malformed domain is refused", (await dom({ op: "add", domain: "not a domain" })).status === 400);
  const taken = await dom({ op: "add", domain: "taken.example" });
  check("the provider's refusal comes back as a clear message", taken.status === 502 && /already registered/.test(taken.json.error ?? ""), taken.json.error);

  const added = await dom({ op: "add", domain: "https://Mail.Acme-Test.dev/" });
  const d1 = added.json.domain;
  check("adding a domain returns its DNS records to publish", added.status === 200 && d1?.name === "mail.acme-test.dev" && d1.records.length === 3 && d1.records.some((r: any) => r.type === "MX" && r.priority === 10), JSON.stringify(added.json).slice(0, 200));
  check("the same domain can't be added twice", (await dom({ op: "add", domain: "mail.acme-test.dev" })).status === 409);
  const early = await dom({ op: "activate", id: d1.id });
  check("an unverified domain can't be the sender", early.status === 400 && /isn't verified/.test(early.json.error ?? ""));

  const c1 = await dom({ op: "check", id: d1.id });
  check("verify while DNS is still spreading shows pending, with each record's status", c1.json.domain?.status === "pending" && c1.json.domain.records.every((r: any) => r.status === "pending" && r.inDns === false) && !!c1.json.domain.checkedAt, JSON.stringify(c1.json).slice(0, 200));
  const c2 = await dom({ op: "check", id: d1.id });
  check("verifying again once DNS is in place marks it verified", c2.json.domain?.status === "verified" && c2.json.domain.records.every((r: any) => r.status === "verified"));

  const on = await dom({ op: "activate", id: d1.id, localPart: "Orders" });
  check("a verified domain becomes the sender, with the chosen address", on.status === 200 && on.json.active === d1.id && on.json.localPart === "orders");
  check("a bad address before the @ is refused", (await dom({ op: "activate", localPart: "no spaces please" })).status === 400);

  // Send as an app user.
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const v1 = (p: string, body: unknown, bearer?: string) =>
    fetch(`${BASE}/cloud/v1/${pid}/${p}`, { method: "POST", headers: { apikey: anonKey, "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
  const su = await v1("auth/signup", { email: "buyer@c45.test", password: "correct-horse-9" });
  const tok = su.json.token ?? su.json.access_token;
  const send1 = await v1("email/send", { to: "someone@c45.test", subject: "Your order", text: "Thanks!", html: "<h1>Thanks!</h1><script>alert(1)</script>" }, tok);
  check("the app's email goes out from the branded address", send1.status < 300 && sent[0]?.from === "Acme Orders <orders@mail.acme-test.dev>", JSON.stringify({ send1: send1.json, sent: sent[0] }));
  await v1("email/send", { to: "bad@c45.test", subject: "Second", text: "Hi" }, tok);

  const out = await call(`/api/projects/${pid}/cloud?view=outbox`);
  check("the outbox shows the From address and the sending limit", out.json.emails?.[0]?.from?.includes("mail.acme-test.dev") && out.json.rate?.sentLastHour === 2 && out.json.rate.limit > 2 && out.json.rate.resetsAt === null, JSON.stringify(out.json.rate));
  const del = await cloud({ action: "refreshDeliveries" });
  const byId = Object.fromEntries((del.json.emails ?? []).map((e: any) => [e.providerId, e.delivery]));
  check("delivery status comes back from the provider (delivered, bounced)", byId.em_1 === "delivered" && byId.em_2 === "bounced", JSON.stringify(byId));
  check("the email's HTML is kept for the preview", (del.json.emails ?? []).some((e: any) => e.html?.includes("<h1>Thanks!</h1>")));

  // Switch domains: a second one, verified, takes over; stopping goes back to the shared address.
  const d2 = (await dom({ op: "add", domain: "news.acme-test.dev" })).json.domain;
  await dom({ op: "check", id: d2.id });
  await dom({ op: "check", id: d2.id });
  const sw = await dom({ op: "activate", id: d2.id });
  await v1("email/send", { to: "x@c45.test", subject: "Third", text: "Hi" }, tok);
  check("switching to another verified domain changes the sender", sw.json.active === d2.id && sent[2]?.from === "Acme Orders <orders@news.acme-test.dev>", sent[2]?.from);
  const rm = await dom({ op: "remove", id: d2.id });
  await v1("email/send", { to: "y@c45.test", subject: "Fourth", text: "Hi" }, tok);
  check("removing the sending domain falls back to the provider's shared address", rm.json.active === null && !rm.json.domains.some((d: any) => d.id === d2.id) && !domains.has(d2.id) && sent[3]?.from === "Acme Orders <onboarding@resend.dev>", sent[3]?.from);
  const list = await call(`/api/projects/${pid}/cloud?view=emailDomains`);
  check("the first domain is still there to switch back to", list.json.domains?.length === 1 && list.json.domains[0].status === "verified");
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  mock.close();
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie: DEV } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
