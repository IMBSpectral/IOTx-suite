/**
 * IOTx Workspace — Team Chat at Slack parity: formatting kept on edit,
 * files and voice messages (privacy, safe serving), scroll-back and deep
 * links, "also send to channel", @channel / @here / user groups, group DMs,
 * channel browser / rename / archive / leave / remove, notification levels,
 * mute, star, mark unread, typing, presence and status, saved items with
 * reminders, scheduled messages, sharing (no leaks), search filters,
 * incoming webhooks, admin export and retention, link-preview safety,
 * missed-mention emails and AI catch-up.
 *   npx tsx scripts/test-chat-pro.mts <devToken> <test-users.json>
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, setup, signIn, sleep, summary, ws, WS } from "./lib.mts";

const ENV = envOf(new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const KEY = ENV.IOTX_SERVICE_KEY;
const OUTBOX = new URL("../../../projects-data/_forge/outbox.jsonl", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function listen(cookie: string) {
  const events: { type: string; data: any }[] = [];
  const ctl = new AbortController();
  const ready = (async () => {
    const r = await fetch(`${WS}/api/stream`, { headers: { cookie }, signal: ctl.signal });
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const type = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (type) events.push({ type, data: data ? JSON.parse(data) : null });
          }
        }
      } catch {}
    })();
  })();
  return {
    ready, events, close: () => ctl.abort(),
    async waitFor(pred: (e: { type: string; data: any }) => boolean, ms = 4000) {
      const t = Date.now();
      while (Date.now() - t < ms) {
        const e = events.find(pred);
        if (e) return e;
        await sleep(50);
      }
      return null;
    },
  };
}

async function up(cookie: string, ch: string, name: string, type: string, data: Buffer | string) {
  const fd = new FormData();
  fd.append("file", new Blob([typeof data === "string" ? data : new Uint8Array(data)], { type }), name);
  const r = await fetch(`${WS}/api/chat/channels/${ch}/files`, { method: "POST", headers: { cookie }, body: fd });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const raw = (cookie: string, p: string) => fetch(`${WS}/api${p}`, { headers: { cookie } });
const tick = async (now: Date) => (await fetch(`${WS}/api/internal/tick`, { method: "POST", headers: { "x-iotx-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ job: "chat", now: now.toISOString() }) })).json();
const notes = async (c: string) => (await ws("/notifications", undefined, c)).json.items as any[];

const { MEMBER, wsId } = await setup();
const O = await signIn(OWNER, "teamchat");
const M = await signIn(MEMBER, "teamchat");
const X = await signIn(OUTSIDER, "teamchat");
const oid = (await ws("/me", undefined, O)).json.me.id as string;
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const mName = (await ws("/me", undefined, M)).json.me.name as string;
const tag = `p${Date.now().toString(36)}`;
const u3 = `${tag}-user3`;
const streams: ReturnType<typeof listen>[] = [];
const dbc = new pg.Client({ connectionString: ENV.DATABASE_URL });
await dbc.connect();
const chanIds: string[] = [];

try {
  const mk = async (name: string, kind = "public", memberIds: string[] = []) => {
    const r = await ws("/chat/channels", { name: `${tag}-${name}`, kind, memberIds }, O);
    chanIds.push(r.json.channel.id);
    return r.json.channel.id as string;
  };
  const pid = await mk("main");
  await ws(`/chat/channels/${pid}`, { action: "join" }, M);
  const post = async (c: string, body: Record<string, unknown>, ch = pid) => ws(`/chat/channels/${ch}/messages`, body, c);

  // ── Formatting survives edits; mentions match whole names only
  const f1 = await post(O, { body: "*Plan*\n- one\n- two\n```\ncode()\n```" });
  check("a formatted, multi-line message is stored as written", f1.status === 201 && f1.json.message.body.includes("\n- two\n"));
  const fe = await ws(`/chat/messages/${f1.json.message.id}`, { body: "*Plan v2*\n- one\n- two" }, O, "PATCH");
  check("editing keeps line breaks", fe.json.message.body === "*Plan v2*\n- one\n- two");
  const loose = await post(O, { body: `ping @${mName}ish about it` });
  check("@Name only matches the whole name", !loose.json.message.mentions.includes(mid));
  const exact = await post(O, { body: `ping @${mName}, thanks` });
  check("…and does match before punctuation", exact.json.message.mentions.includes(mid));

  // ── @channel, @here, user groups
  const all = await post(O, { body: "heads up @channel" });
  check("@channel mentions every member", all.json.message.broadcast === "channel" && all.json.message.mentions.includes(mid));
  const here0 = await post(O, { body: "anyone @here?" });
  check("@here skips people who are offline", here0.json.message.broadcast === "here" && !here0.json.message.mentions.includes(mid));
  const sm = listen(M);
  streams.push(sm);
  await sm.ready;
  await sleep(200);
  const here1 = await post(O, { body: "now @here?" });
  check("@here reaches people who are online", here1.json.message.mentions.includes(mid));
  const g = await ws("/chat/groups", { handle: `${tag}-team`, name: "Test team", memberIds: [mid] }, O);
  check("create a user group", g.status === 201 && g.json.group.handle === `${tag}-team`);
  check("group handles are unique", (await ws("/chat/groups", { handle: `${tag}-team` }, O)).status === 409);
  check("@here can't be a group handle", (await ws("/chat/groups", { handle: "here" }, O)).status === 400);
  const gm = await post(O, { body: `@${tag}-team please look` });
  check("mentioning a group notifies its people", gm.json.message.mentions.includes(mid));
  check("only the group's creator (or an admin) can change it", (await ws(`/chat/groups/${g.json.group.id}`, { name: "x" }, M, "PATCH")).status === 403);

  // ── Typing and presence
  await ws(`/chat/channels/${pid}`, { action: "typing" }, O);
  check("typing is delivered live", !!(await sm.waitFor((e) => e.type === "typing" && e.data.userId === oid && e.data.channelId === pid)));
  let pr = (await ws("/chat/prefs", undefined, O)).json;
  check("presence shows who is online", pr.presence[mid]?.presence === "active");
  await ws("/chat/prefs", { away: true }, M);
  pr = (await ws("/chat/prefs", undefined, O)).json;
  check("…and who set themselves away", pr.presence[mid]?.presence === "away");
  check("presence changes go out live", !!(await sm.waitFor((e) => e.type === "presence" && e.data.userId === mid && e.data.presence === "away")));
  await ws("/chat/prefs", { away: false, dndUntil: new Date(Date.now() + 3600_000).toISOString(), status: "In a meeting", emoji: "📅" }, M);
  pr = (await ws("/chat/prefs", undefined, O)).json;
  check("do not disturb and a custom status show to others", pr.presence[mid]?.presence === "dnd" && pr.presence[mid]?.status === "In a meeting" && pr.presence[mid]?.emoji === "📅");
  await ws("/chat/prefs", { status: "Lunch", until: new Date(Date.now() - 1000).toISOString() }, M);
  pr = (await ws("/chat/prefs", undefined, O)).json;
  check("a status with an end time clears itself", pr.presence[mid]?.status === "");
  await ws("/chat/prefs", { dndUntil: null, status: "", emoji: "" }, M);

  // ── Files and voice messages
  const u1 = await up(O, pid, "chart.png", "image/png", PNG);
  check("upload an image", u1.status === 201 && u1.json.file.type === "image/png" && !("path" in u1.json.file));
  check("an unsent upload is private to the uploader", (await raw(M, `/chat/files/${u1.json.file.id}`)).status === 404);
  check("…someone else can't attach it", (await post(M, { body: "mine now", fileIds: [u1.json.file.id] })).status === 400);
  const fm = await post(O, { body: "", fileIds: [u1.json.file.id] });
  check("send a message that is only a file", fm.status === 201 && fm.json.message.files.length === 1 && fm.json.message.files[0].name === "chart.png");
  const got = await raw(M, `/chat/files/${u1.json.file.id}`);
  check("members can open it, served inline and sandboxed", got.status === 200 && got.headers.get("content-type") === "image/png" && got.headers.get("content-security-policy") === "sandbox" && got.headers.get("x-content-type-options") === "nosniff");
  check("an outsider can't", (await raw(X, `/chat/files/${u1.json.file.id}`)).status === 404);
  check("a sent file can't be attached again", (await post(O, { body: "again", fileIds: [u1.json.file.id] })).status === 400);
  const h = await up(O, pid, "page.html", "text/html", "<script>alert(1)</script>");
  await post(O, { body: "html", fileIds: [h.json.file.id] });
  const hr = await raw(M, `/chat/files/${h.json.file.id}`);
  check("HTML files download instead of running", hr.headers.get("content-type") === "application/octet-stream" && /^attachment/.test(hr.headers.get("content-disposition") ?? ""));
  const v = await up(M, pid, "Voice message.webm", "audio/webm", Buffer.from("fake-audio"));
  const vm = await post(M, { body: "", fileIds: [v.json.file.id] });
  const vr = await raw(O, `/chat/files/${v.json.file.id}`);
  check("a voice message plays inline", vm.status === 201 && vr.headers.get("content-type") === "audio/webm" && /^inline/.test(vr.headers.get("content-disposition") ?? ""));
  const fl = (await ws(`/chat/files?q=chart`, undefined, M)).json.files as any[];
  check("files are searchable by name", fl.some((f) => f.id === u1.json.file.id));
  check("an outsider's file search finds nothing here", !((await ws(`/chat/files?q=chart`, undefined, X)).json.files as any[]).some((f) => f.id === u1.json.file.id));
  check("search has:file finds messages with files", ((await ws(`/chat/search?q=${encodeURIComponent(`has:file in:#${tag}-main`)}`, undefined, M)).json.results as any[]).some((r) => r.id === fm.json.message.id));
  await ws(`/chat/messages/${vm.json.message.id}`, undefined, M, "DELETE");
  check("deleting the message removes its file", (await raw(O, `/chat/files/${v.json.file.id}`)).status === 404);
  check("files over 25 MB are refused", (await up(O, pid, "big.bin", "application/octet-stream", Buffer.alloc(25 * 1024 * 1024 + 1))).status === 400);

  // ── Scroll-back and deep links
  const sb = await mk("history");
  for (let i = 0; i < 12; i++) await post(O, { body: `msg ${i}` }, sb);
  const page1 = (await ws(`/chat/channels/${sb}/messages?limit=5`, undefined, O)).json;
  check("the newest page says there's more", page1.messages.length === 5 && page1.more === true && page1.messages[4].body === "msg 11");
  const page2 = (await ws(`/chat/channels/${sb}/messages?limit=5&before=${encodeURIComponent(page1.messages[0].createdAt)}`, undefined, O)).json;
  check("older messages load before the first one", page2.messages.length === 5 && page2.messages[4].body === "msg 6");
  const old = page2.messages[0];
  const ar = (await ws(`/chat/channels/${sb}/messages?around=${old.id}`, undefined, O)).json;
  check("a deep link loads the messages around an old one", ar.messages.some((m: any) => m.id === old.id) && ar.messages.some((m: any) => m.body === "msg 11"));

  // ── Threads: also send to channel
  const root = (await post(O, { body: "thread root" })).json.message;
  const rep = await post(M, { body: "reply in both places", parentId: root.id, alsoChannel: true });
  const top = (await ws(`/chat/channels/${pid}/messages`, undefined, O)).json.messages as any[];
  check("a reply also sent to the channel shows in the channel", top.some((m) => m.id === rep.json.message.id && m.alsoChannel));
  const th = (await ws(`/chat/channels/${pid}/messages?thread=${root.id}`, undefined, O)).json;
  check("…and in the thread", th.messages.some((m: any) => m.id === rep.json.message.id));
  await post(O, { body: "second reply", parentId: root.id });
  const n0 = await notes(M);
  check("people in a thread hear about new replies", n0.some((n) => n.kind === "reply" && n.link.includes(root.id)));

  // ── Mark unread, system lines, notification levels, mute, star
  await ws(`/chat/channels/${pid}`, { action: "read" }, M);
  const mu = await ws(`/chat/channels/${pid}`, { action: "read", unreadFrom: root.id }, M);
  let un = (await ws("/chat/unread", undefined, M)).json;
  check("mark unread from a message", mu.status === 200 && un.channels[pid] >= 1);
  await ws(`/chat/channels/${pid}`, { action: "read" }, M);
  await ws(`/chat/channels/${pid}`, { action: "leave" }, M);
  await ws(`/chat/channels/${pid}`, { action: "join" }, M);
  const sys = (await ws(`/chat/channels/${pid}/messages`, undefined, O)).json.messages as any[];
  check("joining and leaving post a small system line", sys.some((m) => m.system && /joined the channel/.test(m.body)) && sys.some((m) => m.system && /left the channel/.test(m.body)));
  un = (await ws("/chat/unread", undefined, O)).json;
  check("system lines never count as unread", !un.channels[pid]);
  await ws(`/chat/channels/${pid}`, { action: "prefs", notifyLevel: "none" }, M);
  const before = (await notes(M)).length;
  await post(O, { body: `quiet please @${mName}` });
  check("a channel set to Nothing doesn't notify, even for mentions", (await notes(M)).length === before);
  await ws(`/chat/channels/${pid}`, { action: "prefs", notifyLevel: "all", muted: true, starred: true }, M);
  await ws(`/chat/channels/${pid}`, { action: "read" }, M);
  await post(O, { body: "muted chatter" });
  un = (await ws("/chat/unread", undefined, M)).json;
  check("a muted channel doesn't count as unread", !un.channels[pid]);
  await post(O, { body: `but this is for @${mName}` });
  un = (await ws("/chat/unread", undefined, M)).json;
  check("…unless I'm mentioned", un.channels[pid] === 1);
  const mc = ((await ws("/chat/channels", undefined, M)).json.channels as any[]).find((c) => c.id === pid);
  check("my channel list carries muted, starred and the level", mc.muted === true && mc.starred === true && mc.notifyLevel === "all");
  check("the level must be all, mentions or none", (await ws(`/chat/channels/${pid}`, { action: "prefs", notifyLevel: "loud" }, M)).status === 400);
  await ws(`/chat/channels/${pid}`, { action: "prefs", muted: false }, M);

  // ── Channel browser, rename, archive, remove
  const br = (await ws(`/chat/channels?browse=1&q=${tag}`, undefined, M)).json.channels as any[];
  check("the browser lists public channels with joined flags", br.some((c) => c.id === pid && c.joined) && br.some((c) => c.id === sb && !c.joined));
  const priv = await mk("secret", "private");
  check("…but not private ones I'm not in", !br.some((c) => c.id === priv));
  check("only the creator or an admin can rename", (await ws(`/chat/channels/${pid}`, { action: "update", name: `${tag}-renamed` }, M)).status === 403);
  check("renaming to a taken name is refused", (await ws(`/chat/channels/${pid}`, { action: "update", name: `${tag}-history` }, O)).status === 409);
  const rn = await ws(`/chat/channels/${pid}`, { action: "update", name: `${tag}-renamed`, description: "What this is for" }, O);
  check("rename a channel and set its description", rn.status === 200 && rn.json.channel.name === `${tag}-renamed` && rn.json.channel.description === "What this is for");
  const gen = ((await ws("/chat/channels", undefined, O)).json.channels as any[]).find((c) => c.name === "general" && c.kind === "public");
  check("#general can't be renamed or archived", (await ws(`/chat/channels/${gen.id}`, { action: "update", name: "lobby" }, O)).status === 400 && (await ws(`/chat/channels/${gen.id}`, { action: "update", archived: true }, O)).status === 400);
  check("…or left", (await ws(`/chat/channels/${gen.id}`, { action: "leave" }, M)).status === 400);
  await ws(`/chat/channels/${sb}`, { action: "update", archived: true }, O);
  check("an archived channel is read-only", (await post(O, { body: "hello?" }, sb)).status === 400);
  check("…drops out of the sidebar", !((await ws("/chat/channels", undefined, O)).json.channels as any[]).some((c) => c.id === sb));
  check("…and shows under Archived in the browser", ((await ws(`/chat/channels?browse=1&archived=1&q=${tag}`, undefined, O)).json.channels as any[]).some((c) => c.id === sb && c.archived));
  check("…but its history is still readable", ((await ws(`/chat/channels/${sb}/messages`, undefined, O)).json.messages as any[]).length > 0);
  await ws(`/chat/channels/${sb}`, { action: "update", archived: false }, O);
  check("unarchive it", (await post(O, { body: "back" }, sb)).status === 201);
  check("a member can't remove people from a public channel", (await ws(`/chat/channels/${pid}`, { action: "remove", userId: oid }, M)).status === 403);
  const rm = await ws(`/chat/channels/${pid}`, { action: "remove", userId: mid }, O);
  check("an admin can remove someone", rm.status === 200 && !((await ws(`/chat/channels/${pid}`, undefined, O)).json.channel.memberIds as string[]).includes(mid));
  await ws(`/chat/channels/${pid}`, { action: "join" }, M);
  const addN = await ws(`/chat/channels/${priv}`, { action: "add", memberIds: [mid] }, O);
  check("adding someone tells them", addN.json.added === 1 && (await notes(M)).some((n) => n.kind === "channel" && n.link.includes(priv)));

  // ── Group messages
  await dbc.query(`insert into users (id, email, name, tz, "updatedAt") values ($1, $2, $3, 'UTC', now()) on conflict do nothing`, [u3, `${u3}@localhost`, "Third Person"]);
  await dbc.query(`insert into members (ws, "userId") values ($1, $2) on conflict do nothing`, [wsId, u3]);
  const gd = await ws("/chat/dm", { userIds: [mid, u3] }, O);
  check("start a group message with two others", gd.status === 200 && gd.json.channel.kind === "dm");
  const gd2 = await ws("/chat/dm", { userIds: [u3, mid] }, O);
  check("the same people get the same conversation", gd2.json.channel.id === gd.json.channel.id);
  const gmc = ((await ws("/chat/channels", undefined, M)).json.channels as any[]).find((c) => c.id === gd.json.channel.id);
  check("everyone in it sees it, with all the others listed", !!gmc && gmc.dmWithAll.length === 2 && gmc.dmWithAll.includes(oid) && gmc.dmWithAll.includes(u3));
  check("a group message differs from the one-to-one DM", (await ws("/chat/dm", { userId: mid }, O)).json.channel.id !== gd.json.channel.id);
  check("an outsider can't read it", (await ws(`/chat/channels/${gd.json.channel.id}/messages`, undefined, X)).status === 404);
  const xid = (await ws("/me", undefined, X)).json.me.id as string;
  check("people from another workspace can't be added", (await ws("/chat/dm", { userIds: [mid, xid] }, O)).status === 404);
  check("a group message has at most 9 people", (await ws("/chat/dm", { userIds: Array.from({ length: 9 }, (_, i) => `x${i}`) }, O)).status === 400);

  // ── Saved for later and reminders
  const sv = await ws(`/chat/messages/${root.id}/save`, {}, M);
  check("save a message for later", sv.json.saved === true);
  check("it's in my saved list", ((await ws("/chat/saved", undefined, M)).json.items as any[]).some((x) => x.message.id === root.id));
  check("…not in anyone else's", !((await ws("/chat/saved", undefined, O)).json.items as any[]).some((x) => x.message.id === root.id));
  check("search is:saved finds it", ((await ws(`/chat/search?q=is:saved`, undefined, M)).json.results as any[]).some((r) => r.id === root.id));
  const at = new Date(Date.now() + 10 * 60_000);
  await ws(`/chat/messages/${root.id}/save`, { remindAt: at.toISOString() }, M);
  const t1 = await tick(new Date(at.getTime() + 1000));
  check("the reminder fires at its time", t1.reminded >= 1 && (await notes(M)).some((n) => n.kind === "later" && n.link.includes(root.id)));
  const t2 = await tick(new Date(at.getTime() + 2000));
  check("…once", t2.reminded === 0);
  await ws(`/chat/messages/${root.id}/save`, { done: true }, M);
  check("mark a saved item complete", ((await ws("/chat/saved", undefined, M)).json.items as any[]).find((x) => x.message.id === root.id)?.done === true);
  await ws(`/chat/messages/${root.id}/save`, { saved: false }, M);
  check("remove it", !((await ws("/chat/saved", undefined, M)).json.items as any[]).some((x) => x.message.id === root.id));
  check("an outsider can't save messages here", (await ws(`/chat/messages/${root.id}/save`, {}, X)).status === 404);

  // ── Scheduled messages
  check("scheduling needs a time at least a minute ahead", (await post(O, { body: "too soon", sendAt: new Date(Date.now() + 5000).toISOString() })).status === 400);
  const sendAt = new Date(Date.now() + 5 * 60_000);
  const sc = await post(O, { body: `scheduled ${tag}`, sendAt: sendAt.toISOString() });
  check("schedule a message", sc.status === 201 && sc.json.scheduled.id);
  check("it waits in my Scheduled list", ((await ws("/chat/scheduled", undefined, O)).json.scheduled as any[]).some((s) => s.id === sc.json.scheduled.id));
  check("…and nobody else's", (await ws(`/chat/scheduled/${sc.json.scheduled.id}`, { body: "x" }, M, "PATCH")).status === 404);
  await ws(`/chat/scheduled/${sc.json.scheduled.id}`, { body: `scheduled ${tag} (edited)` }, O, "PATCH");
  check("it isn't posted early", !((await ws(`/chat/channels/${pid}/messages`, undefined, O)).json.messages as any[]).some((m) => m.body.startsWith(`scheduled ${tag}`)));
  const t3 = await tick(new Date(sendAt.getTime() + 1000));
  check("it posts at its time, with the edit", t3.sent >= 1 && ((await ws(`/chat/channels/${pid}/messages`, undefined, M)).json.messages as any[]).some((m) => m.body === `scheduled ${tag} (edited)`));
  check("…and leaves the list", !((await ws("/chat/scheduled", undefined, O)).json.scheduled as any[]).some((s) => s.id === sc.json.scheduled.id));
  const sc2 = await post(O, { body: "send me now", sendAt: new Date(Date.now() + 3600_000).toISOString() });
  const now2 = await ws(`/chat/scheduled/${sc2.json.scheduled.id}`, { sendNow: true }, O, "PATCH");
  check("send a scheduled message now", now2.json.message?.body === "send me now");
  const sc3 = await post(O, { body: "never mind", sendAt: new Date(Date.now() + 3600_000).toISOString() });
  check("cancel a scheduled message", (await ws(`/chat/scheduled/${sc3.json.scheduled.id}`, undefined, O, "DELETE")).status === 200 && !((await ws("/chat/scheduled", undefined, O)).json.scheduled as any[]).some((s) => s.id === sc3.json.scheduled.id));

  // ── Sharing without leaks
  const sh = await post(O, { body: "fyi", sharedId: root.id }, priv);
  check("share a message into another conversation", sh.status === 201 && sh.json.message.shared?.id === root.id && sh.json.message.shared.channelName === `${tag}-renamed`);
  const hidden = await mk("hidden", "private");
  const secret = (await post(O, { body: "top secret numbers" }, hidden)).json.message;
  const leak = await post(O, { body: "look", sharedId: secret.id });
  const asM = ((await ws(`/chat/channels/${pid}/messages`, undefined, M)).json.messages as any[]).find((m) => m.id === leak.json.message.id);
  check("a shared message from a channel I can't see isn't shown to me", !!asM && asM.shared === null);
  check("…though its author's colleagues who can see it do", ((await ws(`/chat/channels/${pid}/messages`, undefined, O)).json.messages as any[]).find((m) => m.id === leak.json.message.id)?.shared?.body === "top secret numbers");
  check("you can't share what you can't see", (await post(M, { body: "steal", sharedId: secret.id })).status === 400);

  // ── Search filters
  const sf = await ws(`/chat/search?q=${encodeURIComponent(`from:me in:#${tag}-renamed fyi`)}`, undefined, O);
  check("from:me and in:#channel narrow search", sf.status === 200 && (sf.json.results as any[]).every((r) => r.userId === oid && r.channelName === `${tag}-renamed`));
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  check("on:YYYY-MM-DD finds today's messages", ((await ws(`/chat/search?q=${encodeURIComponent(`on:${ymd} thread root`)}`, undefined, O)).json.results as any[]).some((r) => r.id === root.id));
  check("before: excludes them", !((await ws(`/chat/search?q=${encodeURIComponent(`before:${ymd} thread root`)}`, undefined, O)).json.results as any[]).some((r) => r.id === root.id));
  check("a bad date is explained", (await ws(`/chat/search?q=before:soon`, undefined, O)).status === 400);
  check("is:thread finds thread messages", ((await ws(`/chat/search?q=${encodeURIComponent(`is:thread in:#${tag}-renamed`)}`, undefined, O)).json.results as any[]).some((r) => r.id === root.id));
  check(`in:@person searches our DMs`, (await ws(`/chat/search?q=${encodeURIComponent(`in:@${mName.replace(/\s+/g, "")} x`)}`, undefined, O)).status === 200);

  // ── Incoming webhooks
  const hk = await ws(`/chat/channels/${pid}/hooks`, { name: "Deploy bot" }, O);
  check("add an incoming webhook", hk.status === 201 && hk.json.hook.token.length >= 24);
  const hl = (await ws(`/chat/channels/${pid}/hooks`, undefined, M)).json.hooks as any[];
  check("the list never shows the secret again", hl.length === 1 && !("token" in hl[0]) && hl[0].tail === hk.json.hook.token.slice(-4));
  const hp = await fetch(`${WS}/api/chat/hooks/${hk.json.hook.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Deploy *finished* ✅" }) });
  const hpj = await hp.json();
  check("posting to it needs no sign-in", hp.status === 200 && hpj.ok);
  const hm = ((await ws(`/chat/channels/${pid}/messages`, undefined, M)).json.messages as any[]).find((m) => m.id === hpj.id);
  check("the message shows the webhook's name", hm?.hookName === "Deploy bot" && hm.body === "Deploy *finished* ✅");
  check("a wrong address is refused", (await fetch(`${WS}/api/chat/hooks/not-a-real-token-at-all-xx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status === 404);
  check("an empty post is refused", (await fetch(`${WS}/api/chat/hooks/${hk.json.hook.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 400);
  check("nobody can edit a webhook's message", (await ws(`/chat/messages/${hpj.id}`, { body: "x" }, O, "PATCH")).status === 403);
  check("an outsider can't add webhooks", (await ws(`/chat/channels/${pid}/hooks`, { name: "x" }, X)).status === 404);
  await ws(`/chat/integrations/${hk.json.hook.id}`, undefined, O, "DELETE");
  check("removing it stops it working", (await fetch(`${WS}/api/chat/hooks/${hk.json.hook.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status === 404);

  // ── Admin: export, retention
  const ex = await raw(O, `/chat/channels/${pid}/export`);
  const exj = await ex.json();
  check("an admin can export a channel", ex.status === 200 && /attachment/.test(ex.headers.get("content-disposition") ?? "") && exj.messages.length > 5 && exj.messages.some((m: any) => m.text === "thread root"));
  check("a member can't", (await raw(M, `/chat/channels/${pid}/export`)).status === 403);
  check("a member can't set retention", (await ws(`/chat/channels/${sb}`, { action: "update", retentionDays: 1 }, M)).status === 403);
  check("retention must be 1–3650 days", (await ws(`/chat/channels/${sb}`, { action: "update", retentionDays: 0 }, O)).status === 400);
  await ws(`/chat/channels/${sb}`, { action: "update", retentionDays: 1 }, O);
  const t4 = await tick(new Date(Date.now() + 2 * 86400_000));
  check("old messages are deleted after the retention period", t4.purged >= 12 && ((await ws(`/chat/channels/${sb}/messages`, undefined, O)).json.messages as any[]).length === 0);

  // ── Link previews never fetch internal addresses
  const lp = await post(O, { body: "see http://127.0.0.1:3100/workspace/api/me and http://localhost:5432" });
  await sleep(1500);
  check("links to internal addresses get no preview", ((await ws(`/chat/messages/${lp.json.message.id}`, undefined, O)).json.message.preview ?? null) === null);

  // ── Missed-mention emails
  for (const s of streams) s.close();
  streams.length = 0;
  await sleep(300);
  await ws(`/chat/channels/${priv}`, { action: "read" }, M);
  const e0 = outbox().length;
  await post(O, { body: `@${mName} can you check the numbers?` }, priv);
  const t5 = await tick(new Date(Date.now() + 6 * 60_000));
  const mails = outbox().slice(e0).filter((m) => m.to === "member@localhost");
  check("a mention someone misses is emailed after 5 minutes", t5.emailed >= 1 && mails.some((m) => /messaged you|new messages/.test(m.subject) && /check the numbers/.test(m.text)));
  const e1 = outbox().length;
  await tick(new Date(Date.now() + 7 * 60_000));
  check("…only once", !outbox().slice(e1).some((m) => m.to === "member@localhost" && /check the numbers/.test(m.text)));
  await ws("/chat/prefs", { email: false }, M);
  const e2 = outbox().length;
  await post(O, { body: `@${mName} one more thing` }, priv);
  await tick(new Date(Date.now() + 6 * 60_000));
  check("no email when they've turned emails off", !outbox().slice(e2).some((m) => m.to === "member@localhost" && /one more thing/.test(m.text)));
  await ws("/chat/prefs", { email: true }, M);

  // ── AI catch-up
  const cu = await ws(`/chat/channels/${pid}/catchup`, {}, M);
  check("AI catch-up summarizes the channel", cu.status === 200 && typeof cu.json.summary === "string" && cu.json.summary.length > 20, cu.json);
  check("an outsider can't catch up on it", (await ws(`/chat/channels/${pid}/catchup`, {}, X)).status === 404);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  for (const s of streams) s.close();
  await ws("/chat/prefs", { away: false, dndUntil: null, status: "", emoji: "", email: true }, M).catch(() => {});
  const ids = (await dbc.query(`select id from channels where name like $1 or "dmKey" like $2`, [`${tag}-%`, `%${u3}%`])).rows.map((r) => r.id as string);
  if (ids.length) {
    await dbc.query(`delete from chat_files where "channelId" = any($1)`, [ids]);
    await dbc.query(`delete from chat_hooks where "channelId" = any($1)`, [ids]);
    await dbc.query(`delete from scheduled_messages where "channelId" = any($1)`, [ids]);
    await dbc.query(`delete from saved_messages where "messageId" in (select id from messages where "channelId" = any($1))`, [ids]);
    await dbc.query(`delete from channels where id = any($1)`, [ids]);
    for (const id of ids) fs.rmSync(path.join(process.cwd(), "storage", "chat-files", id), { recursive: true, force: true });
  }
  await dbc.query(`delete from user_groups where handle like $1`, [`${tag}-%`]);
  await dbc.query(`delete from channel_members where "userId" = $1`, [u3]);
  await dbc.query(`delete from members where "userId" = $1`, [u3]);
  await dbc.query(`delete from users where id = $1`, [u3]);
  await dbc.end();
}
process.exit(summary("Chat (Slack parity)") ? 1 : 0);
