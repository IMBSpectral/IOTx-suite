/**
 * IOTx Workspace — Chat round 2: Web Push (VAPID + aes128gcm, decrypted
 * here), outside guests (invite links, Chat-only, their channels only, DMs,
 * deactivate and new links), bots (token API, signed events and replies,
 * slash commands with ephemeral / in-channel / response_url answers, SSRF
 * guard, rotate / disable) and workflows (joined, keyword, reaction,
 * shortcut with a form, schedule; no loops; ownership).
 * A mock on 127.0.0.1:4796 plays the browser push service and a bot server;
 * the workspace's .env.local lets that one address through
 * (PUSH_EXTRA_HOSTS, CHAT_OUTBOUND_ALLOW).
 *   npx tsx scripts/test-chat-apps.mts <devToken> <test-users.json>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { check, envOf, OWNER, setup, signIn, sleep, summary, ws, WS } from "./lib.mts";

const ENV = envOf(new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const KEY = ENV.IOTX_SERVICE_KEY;
const OUTBOX = new URL("../../../projects-data/_forge/outbox.jsonl", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const tick = async (now: Date) => (await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "x-iotx-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ job: "chat", now: now.toISOString() }) })).json();
const notes = async (c: string) => (await ws("/notifications", undefined, c)).json.items as any[];
const page = async (p: string, cookie = "") => {
  const r = await fetch(`${WS}${p}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, html: await r.text() };
};

// ── Mock push service + bot server ─────────────────────────────────────────
type Hit = { path: string; headers: http.IncomingHttpHeaders; body: Buffer };
const hits: Hit[] = [];
let botSecret = "";
let pushStatus = 201;
const PORT = 4796;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    hits.push({ path: req.url ?? "", headers: req.headers, body });
    if (req.url?.startsWith("/push/")) {
      res.writeHead(pushStatus).end();
      return;
    }
    if (req.url === "/bot") {
      const j = JSON.parse(body.toString("utf8"));
      res.setHeader("content-type", "application/json");
      if (j.type === "slash_command") {
        if (j.text === "public") return res.end(JSON.stringify({ text: `Deployed ${j.command} by ${j.userName}`, response_type: "in_channel" }));
        return res.end(JSON.stringify({ text: `Deploying ${j.text}…` }));
      }
      if (j.type === "event" && /\bping\b/i.test(j.event.text)) return res.end(JSON.stringify({ text: "pong" }));
      return res.end("{}");
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
const MOCK = `http://127.0.0.1:${PORT}`;
const waitHit = async (pred: (h: Hit) => boolean, ms = 5000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const h = hits.find(pred);
    if (h) return h;
    await sleep(50);
  }
  return null;
};

// A browser's push keys.
function uaKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: pub.toString("base64url"), auth: auth.toString("base64url") };
}
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) => {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
};
function decrypt(body: Buffer, k: ReturnType<typeof uaKeys>) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ua = Buffer.from(k.p256dh, "base64url");
  const shared = k.ecdh.computeSecret(asPub);
  const ikm = hkdf(Buffer.from(k.auth, "base64url"), shared, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString("utf8"));
}
function vapidOk(h: Hit, publicKey: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(h.headers.authorization ?? ""));
  if (!m || m[2] !== publicKey) return false;
  const [hd, pl, sig] = m[1].split(".");
  const raw = Buffer.from(publicKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  const ok = crypto.verify("sha256", Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
  const claims = JSON.parse(Buffer.from(pl, "base64url").toString());
  return ok && claims.aud === MOCK && claims.exp > Date.now() / 1000 && String(claims.sub).startsWith("mailto:");
}

const { MEMBER, wsId } = await setup();
const O = await signIn(OWNER, "teamchat");
const M = await signIn(MEMBER, "teamchat");
const oid = (await ws("/me", undefined, O)).json.me.id as string;
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const mName = (await ws("/me", undefined, M)).json.me.name as string;
const tag = `a${Date.now().toString(36)}`;
const dbc = new pg.Client({ connectionString: ENV.DATABASE_URL });
await dbc.connect();
const made = { channels: [] as string[], bots: [] as string[], wfs: [] as string[], guests: [] as string[], projects: [] as string[] };
const post = async (c: string, ch: string, body: string) => ws(`/chat/channels/${ch}/messages`, { body }, c);
const list = async (c: string, ch: string) => (await ws(`/chat/channels/${ch}/messages`, undefined, c)).json.messages as any[];
const newChannel = async (name: string, kind = "public", memberIds: string[] = []) => {
  const r = await ws("/chat/channels", { name, kind, memberIds }, O);
  made.channels.push(r.json.channel.id);
  return r.json.channel.id as string;
};

try {
  // ── Push ────────────────────────────────────────────────────────────────
  const pk = await ws("/push", undefined, M);
  const publicKey = pk.json.publicKey as string;
  check("push: the VAPID public key is a P-256 point", Buffer.from(publicKey ?? "", "base64url").length === 65 && Buffer.from(publicKey, "base64url")[0] === 4, pk.json);
  check("push: an unknown push host is refused", (await ws("/push", { subscription: { endpoint: "https://evil.example.com/x", keys: uaKeys() } }, M)).status === 400);
  const k = uaKeys();
  const sub = { endpoint: `${MOCK}/push/${tag}`, keys: { p256dh: k.p256dh, auth: k.auth } };
  check("push: bad keys are refused", (await ws("/push", { subscription: { ...sub, keys: { p256dh: "AAAA", auth: k.auth } } }, M)).status === 400);
  check("push: a browser subscribes", (await ws("/push", { subscription: sub }, M)).status === 201);
  check("push: the device is counted", (await ws("/push", undefined, M)).json.devices >= 1);
  const t1 = await ws("/push/test", {}, M);
  check("push: a test push is accepted", t1.json.delivered === 1, t1.json);
  const h1 = await waitHit((h) => h.path === `/push/${tag}`);
  check("push: sent as aes128gcm with a TTL", h1?.headers["content-encoding"] === "aes128gcm" && !!h1?.headers.ttl, h1?.headers);
  check("push: signed with VAPID (ES256, right audience)", !!h1 && vapidOk(h1, publicKey));
  let d1: any = null;
  try {
    d1 = decrypt(h1!.body, k);
  } catch (e) {
    d1 = String(e);
  }
  check("push: the browser can decrypt it", d1?.title === "Notifications are on", d1);
  await ws("/chat/prefs", { push: true }, M);
  const pch = await newChannel(`push-${tag}`, "public", [mid]);
  hits.length = 0;
  await post(O, pch, `@${mName} can you check the push ${tag}?`);
  const h2 = await waitHit((h) => h.path === `/push/${tag}`);
  const d2 = h2 ? decrypt(h2.body, k) : null;
  check("push: a mention reaches a person with no tab open", !!d2 && /mentioned you/.test(d2.title) && d2.body.includes(tag) && d2.url.startsWith("/workspace/chat?channel="), d2);
  await ws("/chat/prefs", { push: false }, M);
  hits.length = 0;
  await post(O, pch, `@${mName} again ${tag}`);
  check("push: off in preferences means no push", !(await waitHit((h) => h.path === `/push/${tag}`, 1500)));
  await ws("/chat/prefs", { push: true }, M);
  pushStatus = 410;
  await ws("/push/test", {}, M);
  pushStatus = 201;
  const gone = await dbc.query("select count(*)::int n from push_subs where endpoint = $1", [sub.endpoint]);
  check("push: a subscription the push service says is gone is deleted", gone.rows[0].n === 0);
  await ws("/push", { subscription: sub }, M);
  check("push: unsubscribing removes it", (await ws("/push", { endpoint: sub.endpoint }, M, "DELETE")).json.removed === 1);

  // ── Guests ──────────────────────────────────────────────────────────────
  const gPriv = await newChannel(`partner-${tag}`, "private", [mid]);
  const gPub = await newChannel(`open-${tag}`, "public");
  const gEmail = `guest-${tag}@partner.test`;
  check("guests: a member (not admin) can't invite", (await ws("/chat/guests", { email: gEmail, channelIds: [gPriv] }, M)).status === 403);
  check("guests: a channel is required", (await ws("/chat/guests", { email: gEmail, channelIds: [] }, O)).status === 400);
  const before = outbox().length;
  const inv = await ws("/chat/guests", { email: gEmail, name: "Pat Partner", channelIds: [gPriv], note: "Welcome aboard" }, O);
  check("guests: an admin invites a guest", inv.status === 201 && inv.json.guest.status === "invited", inv.json);
  made.guests.push(inv.json.guest.id);
  const mail = outbox().slice(before).find((m) => m.to === gEmail);
  const link = /\/workspace\/chat\/guest\/([\w-]+)/.exec(mail?.text ?? "")?.[1] ?? "";
  check("guests: the invitation email has a one-time link and names the channel", !!link && mail.text.includes(`#partner-${tag}`) && mail.text.includes("Welcome aboard"), mail?.text);
  const jp = await page(`/chat/guest/${link}`);
  check("guests: the join page shows the invitation", jp.status === 200 && jp.html.includes(`partner-${tag}`) && jp.html.includes("Join"));
  check("guests: a made-up link shows the expired page", (await page(`/chat/guest/${"x".repeat(43)}`)).html.includes("This link has expired"));
  const acc = await fetch(`${WS}/api/chat/guest-auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: link, name: "Pat Partner", tz: "Europe/Berlin" }) });
  const G = `iotx_ws_session=${/iotx_ws_session=([^;]+)/.exec(acc.headers.get("set-cookie") ?? "")?.[1]}`;
  check("guests: the link signs the guest in", acc.status === 200 && G.length > 30);
  check("guests: the link works only once", (await ws("/chat/guest-auth", { token: link, name: "x" })).status === 410);
  const gme = (await ws("/me", undefined, G)).json.me;
  check("guests: the guest is a guest_ account", String(gme?.id).startsWith("guest_"), gme);
  const gid = gme.id as string;
  const gchs = (await ws("/chat/channels", undefined, G)).json.channels as any[];
  check("guests: they see only their channel (not #general or public channels)", gchs.length === 1 && gchs[0].id === gPriv, gchs.map((c) => c.name));
  check("guests: the channel browser shows only their channel", ((await ws("/chat/channels?browse=1", undefined, G)).json.channels as any[]).every((c) => c.id === gPriv));
  check("guests: a public channel's messages are hidden", (await ws(`/chat/channels/${gPub}/messages`, undefined, G)).status === 404);
  check("guests: they can't post in a public channel", (await post(G, gPub, "hello")).status === 404);
  check("guests: they can't join a public channel", (await ws(`/chat/channels/${gPub}`, { action: "join" }, G)).status === 404);
  const gp = await post(G, gPriv, `Hi from the partner ${tag}`);
  check("guests: they post in their channel", gp.status === 201);
  check("guests: colleagues see the guest's message", (await list(O, gPriv)).some((m) => m.userId === gid && m.body.includes(tag)));
  check("guests: a system line says they joined as a guest", (await list(O, gPriv)).some((m) => m.userId === gid && m.system && m.body === "joined as a guest"));
  check("guests: no other app (Tasks API refuses)", (await ws("/tasks/projects", undefined, G)).status === 403);
  check("guests: other app pages say Chat only", (await page("/calendar", G)).html.includes("Guests can use Chat only"));
  const gpage = await page("/chat", G);
  check("guests: Chat opens in the guest frame (no suite shell)", gpage.status === 200 && gpage.html.includes("gf-top") && !gpage.html.includes("ix-root"));
  check("guests: they can DM someone in their channel", (await ws("/chat/dm", { userId: mid }, G)).status === 200);
  const stranger = (await dbc.query(`select "userId" from members where ws = $1 and "userId" <> all($2) and "userId" not like 'guest\_%' and "userId" not like 'bot\_%' limit 1`, [wsId, [oid, mid]])).rows[0]?.userId;
  check("guests: they can't DM someone outside their channels", !stranger || (await ws("/chat/dm", { userId: stranger }, G)).status === 403, stranger);
  check("guests: they can't add people", (await ws(`/chat/channels/${gPriv}`, { action: "add", memberIds: [oid] }, G)).status === 403);
  check("guests: a member can't add a guest to a channel", (await ws(`/chat/channels/${gPub}`, { action: "add", memberIds: [gid] }, M)).status === 403);
  check("guests: they can't build workflows", (await ws("/chat/workflows", { name: "x", trigger: { type: "joined", channelId: gPriv }, steps: [{ type: "message", channelId: "trigger", text: "x" }] }, G)).status === 403);
  // Live events: their channel yes, public channels no.
  const gs = await fetch(`${WS}/api/stream`, { headers: { cookie: G } });
  const reader = gs.body!.getReader();
  let seen = "";
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      seen += dec.decode(value, { stream: true });
    }
  })();
  await sleep(300);
  await post(O, gPub, `public secret ${tag}`);
  await post(O, gPriv, `shared news ${tag}`);
  await sleep(800);
  check("guests: live events from their channel arrive", seen.includes(`shared news ${tag}`));
  check("guests: live events from public channels don't", !seen.includes(`public secret ${tag}`));
  await reader.cancel().catch(() => {});
  await pump;
  const gn0 = (await notes(G)).length;
  await post(O, gPub, `@Pat Partner look here ${tag}`);
  await sleep(300);
  check("guests: a mention outside their channels doesn't notify them", (await notes(G)).length === gn0);
  await ws(`/chat/guests/${inv.json.guest.id}`, { channelIds: [gPriv, gPub] }, O, "PATCH");
  check("guests: an admin adds a channel and the guest sees it", ((await ws("/chat/channels", undefined, G)).json.channels as any[]).some((c) => c.id === gPub));
  await ws(`/chat/guests/${inv.json.guest.id}`, { channelIds: [gPriv] }, O, "PATCH");
  check("guests: removing it takes it away", !((await ws("/chat/channels", undefined, G)).json.channels as any[]).some((c) => c.id === gPub));
  const gl = (await ws("/chat/guests", undefined, O)).json.guests as any[];
  check("guests: the admin list shows them as active", gl.some((x) => x.email === gEmail && x.status === "active" && x.channels.includes(`partner-${tag}`)));
  await ws(`/chat/guests/${inv.json.guest.id}`, { deactivated: true }, O, "PATCH");
  check("guests: deactivating signs them out", (await ws("/chat/channels", undefined, G)).status === 401);
  const b2 = outbox().length;
  await ws("/chat/guest-auth", { email: gEmail });
  check("guests: a deactivated guest gets no new link", !outbox().slice(b2).some((m) => m.to === gEmail));
  await ws(`/chat/guests/${inv.json.guest.id}`, { deactivated: false }, O, "PATCH");
  const b3 = outbox().length;
  const rq = await ws("/chat/guest-auth", { email: gEmail });
  const relink = /\/workspace\/chat\/guest\/([\w-]+)/.exec(outbox().slice(b3).find((m) => m.to === gEmail)?.text ?? "")?.[1];
  check("guests: after reactivation, asking by email sends a new link", rq.json.ok === true && !!relink);
  const acc2 = await fetch(`${WS}/api/chat/guest-auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: relink, name: "Pat P." }) });
  const G2 = `iotx_ws_session=${/iotx_ws_session=([^;]+)/.exec(acc2.headers.get("set-cookie") ?? "")?.[1]}`;
  check("guests: the new link signs the same account in", (await ws("/me", undefined, G2)).json.me?.id === gid);
  const b4 = outbox().length;
  check("guests: asking for an unknown address still says ok (no hints)", (await ws("/chat/guest-auth", { email: `nobody-${tag}@x.test` })).json.ok === true && outbox().length === b4);
  check("guests: an existing colleague can't be invited as a guest", (await ws("/chat/guests", { email: (await ws("/me", undefined, M)).json.me.email, channelIds: [gPriv] }, O)).status === 400);

  // ── Bots ────────────────────────────────────────────────────────────────
  check("bots: a member can't add one", (await ws("/chat/bots", { name: "x" }, M)).status === 403);
  check("bots: an internal address is refused", (await ws("/chat/bots", { name: "x", eventsUrl: "http://10.1.2.3/hook" }, O)).status === 400);
  check("bots: localhost is refused", (await ws("/chat/bots", { name: "x", eventsUrl: "http://localhost:9999/hook" }, O)).status === 400);
  check("bots: a built-in command name is refused", (await ws("/chat/bots", { name: "x", commands: [{ command: "topic" }] }, O)).status === 400);
  const cb = await ws("/chat/bots", { name: `Deploybot ${tag}`, description: "Ships things", eventsUrl: `${MOCK}/bot`, commands: [{ command: `deploy${tag}`, description: "Deploy a branch" }] }, O);
  check("bots: an admin creates one (token and secret shown once)", cb.status === 201 && /^xbot-/.test(cb.json.token) && cb.json.secret.length === 48, cb.json);
  made.bots.push(cb.json.bot.id);
  botSecret = cb.json.secret;
  const BOT = { authorization: `Bearer ${cb.json.token}` };
  const buid = cb.json.bot.userId as string;
  check("bots: a duplicate command is refused", (await ws("/chat/bots", { name: "y", commands: [{ command: `deploy${tag}` }] }, O)).status === 400);
  check("bots: the list never shows tokens", !JSON.stringify((await ws("/chat/bots", undefined, M)).json).includes("xbot-"));
  const bapi = (p: string, body?: unknown, h: Record<string, string> = BOT, method?: string) =>
    fetch(`${WS}/api/chat/bot${p}`, { method: method ?? (body ? "POST" : "GET"), headers: { ...h, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  check("bots: the API needs the token", (await bapi("/channels", undefined, {})).status === 401);
  check("bots: a wrong token is refused", (await bapi("/channels", undefined, { authorization: "Bearer xbot-wrongwrongwrongwrongwrong" })).status === 401);
  const bch = await newChannel(`bots-${tag}`, "private", [mid]);
  check("bots: posting where it isn't a member is refused", [403, 404].includes((await bapi("/messages", { channel: bch, text: "hi" })).status));
  await ws(`/chat/channels/${bch}`, { action: "add", memberIds: [buid] }, O);
  const bp = await bapi("/messages", { channel: bch, text: `Build ${tag} is green` });
  check("bots: posts once added to the channel", bp.status === 201 && bp.json.message.app === true && bp.json.message.userId === buid, bp.json);
  check("bots: lists its channels", ((await bapi("/channels")).json.channels as any[]).some((c) => c.id === bch));
  check("bots: reads history", ((await bapi(`/messages?channel=${bch}`)).json.messages as any[]).some((m) => m.body.includes(`Build ${tag}`)));
  check("bots: edits its own message", (await bapi(`/messages/${bp.json.message.id}`, { text: `Build ${tag} is green ✅` }, BOT, "PATCH")).status === 200);
  hits.length = 0;
  await post(O, bch, `ping ${tag}`);
  const ev = await waitHit((h) => h.path === "/bot");
  const evj = ev ? JSON.parse(ev.body.toString()) : null;
  const ts = String(ev?.headers["x-iotx-timestamp"] ?? "");
  const want = `v0=${crypto.createHmac("sha256", botSecret).update(`v0:${ts}:${ev?.body.toString()}`).digest("hex")}`;
  check("bots: get people's messages as signed events", evj?.event?.type === "message" && evj.event.channel === bch && evj.event.user === oid && ev?.headers["x-iotx-signature"] === want, evj);
  await sleep(800);
  check("bots: a { text } answer is posted back as the bot", (await list(O, bch)).some((m) => m.userId === buid && m.body === "pong"));
  check("bots: its own messages don't come back as events", hits.filter((h) => h.path === "/bot").length === 1);
  hits.length = 0;
  await post(O, bch, `@Deploybot ${tag} status please`);
  const ev2 = await waitHit((h) => h.path === "/bot");
  check("bots: a mention arrives as app_mention", JSON.parse(ev2?.body.toString() ?? "{}").event?.type === "app_mention");
  const dm = await ws("/chat/dm", { userId: buid }, O);
  hits.length = 0;
  await post(O, dm.json.channel.id, `ping in private ${tag}`);
  const ev3 = await waitHit((h) => h.path === "/bot");
  check("bots: direct messages reach the bot", JSON.parse(ev3?.body.toString() ?? "{}").event?.channelType === "dm");
  made.channels.push(dm.json.channel.id);
  const cmds = (await ws("/chat/commands", undefined, M)).json.commands as any[];
  check("bots: their slash commands are listed for everyone", cmds.some((c) => c.command === `deploy${tag}` && c.bot.startsWith("Deploybot")));
  hits.length = 0;
  const run1 = await ws("/chat/commands", { channelId: bch, command: `deploy${tag}`, text: "staging" }, M);
  const cmdHit = JSON.parse((await waitHit((h) => h.path === "/bot"))?.body.toString() ?? "{}");
  check("bots: a command reaches the bot with a response_url", cmdHit.type === "slash_command" && cmdHit.text === "staging" && cmdHit.user === mid && /\/api\/chat\/bot\/respond\//.test(cmdHit.response_url), cmdHit);
  check("bots: a plain answer is only for the sender", run1.json.ephemeral === "Deploying staging…", run1.json);
  check("bots: … and isn't posted", !(await list(O, bch)).some((m) => m.body === "Deploying staging…"));
  const run2 = await ws("/chat/commands", { channelId: bch, command: `deploy${tag}`, text: "public" }, M);
  check("bots: an in_channel answer is posted", run2.json.message?.userId === buid && run2.json.message.body.includes(mName), run2.json);
  const ru = new URL(cmdHit.response_url);
  const later = await fetch(`${WS}${ru.pathname.replace(/^\/workspace/, "")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `Done: staging ${tag}`, response_type: "in_channel" }) });
  check("bots: a later answer through response_url is posted", later.status === 200 && (await list(O, bch)).some((m) => m.userId === buid && m.body === `Done: staging ${tag}`));
  check("bots: a made-up response_url is refused", (await fetch(`${WS}/api/chat/bot/respond/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status === 404);
  check("bots: commands can't be used outside your channels", (await ws("/chat/commands", { channelId: gPub, command: `deploy${tag}`, text: "x" }, M)).status === 400);
  const rot = await ws(`/chat/bots/${cb.json.bot.id}`, { rotate: true }, O, "PATCH");
  check("bots: a new token replaces the old one", (await bapi("/channels")).status === 401 && (await bapi("/channels", undefined, { authorization: `Bearer ${rot.json.token}` })).status === 200);
  await ws(`/chat/bots/${cb.json.bot.id}`, { disabled: true }, O, "PATCH");
  check("bots: turned off, the token stops working", (await bapi("/channels", undefined, { authorization: `Bearer ${rot.json.token}` })).status === 401);
  check("bots: turned off, its commands disappear", !((await ws("/chat/commands", undefined, M)).json.commands as any[]).some((c) => c.command === `deploy${tag}`));

  // ── Workflows ───────────────────────────────────────────────────────────
  const wch = await newChannel(`flows-${tag}`, "public");
  check("workflows: only channels you're in", (await ws("/chat/workflows", { name: "x", trigger: { type: "joined", channelId: wch }, steps: [{ type: "message", channelId: "trigger", text: "x" }] }, M)).status === 400);
  const w1 = await ws("/chat/workflows", { name: `Welcome ${tag}`, trigger: { type: "joined", channelId: wch }, steps: [{ type: "message", channelId: "trigger", text: "Welcome {{user}} to {{channel}}! 👋" }] }, O);
  check("workflows: a welcome workflow is saved", w1.status === 201, w1.json);
  made.wfs.push(w1.json.workflow.id);
  await ws(`/chat/channels/${wch}`, { action: "join" }, M);
  await sleep(600);
  const wm = (await list(O, wch)).find((m) => m.userId === `wf_${w1.json.workflow.id}`);
  check("workflows: someone joins → the welcome is posted as the workflow", !!wm && wm.body === `Welcome @${mName} to #flows-${tag}! 👋` && wm.app && wm.hookName === `Welcome ${tag}`, wm);
  check("workflows: … and it mentions them", !!wm?.mentions.includes(mid));
  const w2 = await ws("/chat/workflows", { name: `Help ${tag}`, trigger: { type: "keyword", channelId: wch, keyword: "help" }, steps: [{ type: "react", emoji: "👀" }, { type: "dm", to: "trigger_user", text: "Saw your request: {{message}}" }, { type: "message", channelId: "trigger", text: "help is on the way" }] }, O);
  made.wfs.push(w2.json.workflow.id);
  const hm = await post(M, wch, `I need help with invoices ${tag}`);
  await sleep(800);
  const hmNow = (await list(O, wch)).find((m) => m.id === hm.json.message.id);
  check("workflows: a keyword adds the reaction", !!hmNow?.reactions.some((r: any) => r.emoji === "👀" && r.users.includes(`wf_${w2.json.workflow.id}`)), hmNow?.reactions);
  const mchs = (await ws("/chat/channels", undefined, M)).json.channels as any[];
  const wdm = mchs.find((c) => c.kind === "dm" && c.dmWith === `wf_${w2.json.workflow.id}`);
  check("workflows: … and DMs the person", !!wdm && (await list(M, wdm.id)).some((m) => m.body.includes(`I need help with invoices ${tag}`)));
  if (wdm) made.channels.push(wdm.id);
  check("workflows: its own message with the keyword doesn't loop", (await list(O, wch)).filter((m) => m.body === "help is on the way").length === 1);
  const proj = await ws("/tasks/projects", { name: `Chat flows ${tag}` }, O);
  made.projects.push(proj.json.project.id);
  const w3 = await ws("/chat/workflows", { name: `Ticket ${tag}`, trigger: { type: "reaction", channelId: wch, emoji: "🎫" }, steps: [{ type: "task", projectId: proj.json.project.id, title: "Follow up: {{message}}", assignee: "trigger_user" }] }, O);
  made.wfs.push(w3.json.workflow.id);
  await ws(`/chat/messages/${hm.json.message.id}/reactions`, { emoji: "🎫" }, O);
  await sleep(800);
  const task = await dbc.query("select title, \"assigneeId\" from tasks where \"projectId\" = $1", [proj.json.project.id]);
  check("workflows: a reaction creates a task, assigned to whoever reacted", task.rows.length === 1 && task.rows[0].title.startsWith(`Follow up: I need help with invoices ${tag}`) && task.rows[0].assigneeId === oid, task.rows);
  const w4 = await ws("/chat/workflows", {
    name: `Request ${tag}`,
    trigger: { type: "shortcut", channelId: wch, fields: [{ key: "what", label: "What do you need?", type: "long", required: true }, { key: "urgency", label: "Urgency", type: "select", options: "low,high" }] },
    steps: [{ type: "message", channelId: "trigger", text: "New request from {{user}} ({{form.urgency}}): {{form.what}}" }],
  }, O);
  made.wfs.push(w4.json.workflow.id);
  const sc = (await ws(`/chat/workflows?channelId=${wch}`, undefined, M)).json.workflows as any[];
  check("workflows: shortcuts are listed for the channel", sc.some((w) => w.id === w4.json.workflow.id && w.fields.length === 2));
  check("workflows: a required answer is required", (await ws(`/chat/workflows/${w4.json.workflow.id}`, { channelId: wch, form: {} }, M)).status === 400);
  check("workflows: a choice must be an option", (await ws(`/chat/workflows/${w4.json.workflow.id}`, { channelId: wch, form: { what: "x", urgency: "meh" } }, M)).status === 400);
  const r4 = await ws(`/chat/workflows/${w4.json.workflow.id}`, { channelId: wch, form: { what: `a new laptop ${tag}`, urgency: "high" } }, M);
  await sleep(300);
  check("workflows: the form's answers are posted", r4.status === 200 && (await list(O, wch)).some((m) => m.body === `New request from @${mName} (high): a new laptop ${tag}`), r4.json);
  // Schedule: due now in UTC, every day.
  const now = new Date();
  const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const w5 = await ws("/chat/workflows", { name: `Standup ${tag}`, trigger: { type: "schedule", channelId: wch, time: hhmm, days: [0, 1, 2, 3, 4, 5, 6], tz: "UTC" }, steps: [{ type: "message", channelId: "trigger", text: `Standup time ${tag}` }] }, O);
  made.wfs.push(w5.json.workflow.id);
  // A schedule saved after today's time has passed waits for tomorrow; put it back to "not run today".
  await dbc.query("update chat_workflows set \"lastDay\" = null where id = $1", [w5.json.workflow.id]);
  await tick(new Date(now.getTime() + 60_000));
  await tick(new Date(now.getTime() + 90_000));
  await sleep(300);
  check("workflows: a schedule posts once at its time", (await list(O, wch)).filter((m) => m.body === `Standup time ${tag}`).length === 1);
  await ws(`/chat/workflows/${w1.json.workflow.id}`, { enabled: false }, O, "PATCH");
  await ws(`/chat/channels/${wch}`, { action: "leave" }, M);
  await ws(`/chat/channels/${wch}`, { action: "join" }, M);
  await sleep(500);
  check("workflows: turned off, it doesn't run", (await list(O, wch)).filter((m) => m.userId === `wf_${w1.json.workflow.id}`).length === 1);
  check("workflows: someone else can't change yours", (await ws(`/chat/workflows/${w2.json.workflow.id}`, { name: "mine now" }, M, "PATCH")).status === 403);
  check("workflows: you see your own (admins see all)", ((await ws("/chat/workflows", undefined, M)).json.workflows as any[]).length === 0 && ((await ws("/chat/workflows", undefined, O)).json.workflows as any[]).length >= 5);
  check("workflows: a scheduled DM to 'the person' is refused", (await ws("/chat/workflows", { name: "x", trigger: { type: "schedule", channelId: wch, time: "09:00", days: [1] }, steps: [{ type: "dm", to: "trigger_user", text: "x" }] }, O)).status === 400);
  check("workflows: deleting works", (await ws(`/chat/workflows/${w2.json.workflow.id}`, undefined, O, "DELETE")).status === 200);
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
} finally {
  for (const id of made.wfs) await dbc.query("delete from chat_workflows where id = $1", [id]);
  for (const id of made.bots) {
    const b = await dbc.query("delete from chat_bots where id = $1 returning \"userId\"", [id]);
    for (const r of b.rows) {
      await dbc.query("delete from channel_members where \"userId\" = $1", [r.userId]);
      await dbc.query("delete from members where \"userId\" = $1", [r.userId]);
    }
  }
  for (const id of made.guests) {
    const g = await dbc.query("delete from chat_guests where id = $1 returning \"userId\"", [id]);
    for (const r of g.rows) if (r.userId) {
      await dbc.query("delete from sessions where \"userId\" = $1", [r.userId]);
      await dbc.query("delete from channel_members where \"userId\" = $1", [r.userId]);
      await dbc.query("delete from members where \"userId\" = $1", [r.userId]);
      await dbc.query("delete from notifications where \"userId\" = $1", [r.userId]);
    }
  }
  for (const id of made.channels) await dbc.query("delete from channels where id = $1", [id]);
  for (const id of made.projects) await dbc.query("delete from projects where id = $1", [id]);
  await dbc.query("delete from push_subs where endpoint like $1", [`${MOCK}/push/%`]);
  await dbc.end();
  server.close();
}
process.exit(summary("Chat round 2 (push, guests, bots, workflows)") ? 1 : 0);
