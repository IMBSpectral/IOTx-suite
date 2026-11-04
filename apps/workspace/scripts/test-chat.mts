/**
 * IOTx Workspace — Team Chat: channels (public/private), DMs, SSE delivery
 * with heartbeat headers, threads, @mentions, reactions, edit/delete, pins,
 * unread counts, search, "Make this a task", "Summarize this thread" (Claude),
 * isolation and permissions.
 *   npx tsx scripts/test-chat.mts <devToken> <test-users.json>
 */
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, resetMember, setMemberPerm, setup, signIn, sleep, summary, ws, WS } from "./lib.mts";

/** A tiny SSE client that collects events. */
function listen(cookie: string) {
  const events: { type: string; data: any }[] = [];
  const ctl = new AbortController();
  let headers: Headers | null = null;
  const ready = (async () => {
    const r = await fetch(`${WS}/api/stream`, { headers: { cookie }, signal: ctl.signal });
    headers = r.headers;
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
    ready, events, close: () => ctl.abort(), headers: () => headers,
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

const { MEMBER } = await setup();
const O = await signIn(OWNER, "teamchat");
const M = await signIn(MEMBER, "teamchat");
const X = await signIn(OUTSIDER, "teamchat");
const me = (await ws("/me", undefined, O)).json.me;
const mid = (await ws("/me", undefined, M)).json.me.id as string;
const mName = (await ws("/me", undefined, M)).json.me.name as string;
const tag = `c${Date.now().toString(36)}`;
const streams: ReturnType<typeof listen>[] = [];
let projectId = "";

try {
  // ── Channels
  const chs = (await ws("/chat/channels", undefined, O)).json.channels as any[];
  const general = chs.find((c) => c.kind === "public" && c.name === "general");
  check("a #general channel exists for the workspace", !!general);
  const pub = await ws("/chat/channels", { name: `${tag}-launch`, topic: "Launch planning" }, O);
  check("create a public channel", pub.status === 201 && pub.json.channel.kind === "public");
  const pid = pub.json.channel.id as string;
  check("channel names are unique", (await ws("/chat/channels", { name: `${tag}-launch` }, O)).status === 409);
  const priv = await ws("/chat/channels", { name: `${tag}-secret`, kind: "private" }, O);
  const privId = priv.json.channel.id as string;
  let mch = (await ws("/chat/channels", undefined, M)).json.channels as any[];
  check("a colleague sees public channels but not a private one they're not in", mch.some((c) => c.id === pid && !c.joined) && !mch.some((c) => c.id === privId));
  check("…and can't read the private one", (await ws(`/chat/channels/${privId}/messages`, undefined, M)).status === 404);
  check("…or join it", (await ws(`/chat/channels/${privId}`, { action: "join" }, M)).status === 404);
  await ws(`/chat/channels/${privId}`, { action: "add", memberIds: [mid] }, O);
  mch = (await ws("/chat/channels", undefined, M)).json.channels;
  check("added to the private channel, they see it", mch.some((c) => c.id === privId));
  check("joining a public channel", (await ws(`/chat/channels/${pid}`, { action: "join" }, M)).status === 200);

  // ── Real-time delivery over SSE
  const sm = listen(M);
  const sx = listen(X);
  streams.push(sm, sx);
  await sm.ready;
  await sx.ready;
  check("the stream is text/event-stream, uncached and unbuffered (works behind a proxy)", sm.headers()?.get("content-type")?.startsWith("text/event-stream") === true && /no-cache/.test(sm.headers()?.get("cache-control") ?? "") && sm.headers()?.get("x-accel-buffering") === "no");
  check("the stream says hello at once", !!(await sm.waitFor((e) => e.type === "hello")));
  const hb = (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 24_000);
    try {
      const r = await fetch(`${WS}/api/stream`, { headers: { cookie: O }, signal: ctl.signal });
      const rd = r.body!.getReader();
      let s = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) return false;
        s += new TextDecoder().decode(value);
        if (s.includes(": heartbeat")) return true;
      }
    } catch {
      return false;
    } finally {
      clearTimeout(t);
      ctl.abort();
    }
  })();
  const p1 = await ws(`/chat/channels/${pid}/messages`, { body: `Kickoff at 10. Docs: https://docs.example.com/plan @${mName} please review` }, O);
  check("send a message", p1.status === 201);
  const m1 = p1.json.message;
  const got = await sm.waitFor((e) => e.type === "message" && e.data.message.id === m1.id);
  check("a colleague receives it in real time over SSE", !!got && got.data.message.body.includes("Kickoff"));
  check("@mentions are recognised", m1.mentions.includes(mid));
  const mn = await sm.waitFor((e) => e.type === "notification" && e.data.notification.kind === "mention");
  check("the mentioned person gets a notification (live, over SSE)", !!mn && mn.data.notification.link.includes(m1.id));
  const pp = await ws(`/chat/channels/${privId}/messages`, { body: `private plans ${tag}` }, O);
  await sleep(400);
  check("an outsider's stream gets nothing from this workspace", !sx.events.some((e) => e.type === "message"));
  check("private channel messages reach members", !!(await sm.waitFor((e) => e.type === "message" && e.data.message.id === pp.json.message.id)));

  // ── Unread counts
  let un = (await ws("/chat/unread", undefined, M)).json;
  check("unread counts per channel and in total", un.channels[pid] === 1 && un.channels[privId] === 1 && un.total >= 2, un);
  mch = (await ws("/chat/channels", undefined, M)).json.channels;
  check("the channel list shows unread and mention counts", mch.find((c) => c.id === pid)?.unread === 1 && mch.find((c) => c.id === pid)?.mentions === 1);
  await ws(`/chat/channels/${pid}`, { action: "read" }, M);
  un = (await ws("/chat/unread", undefined, M)).json;
  check("reading a channel clears its count", !un.channels[pid] && un.channels[privId] === 1);
  check("my own messages don't count as unread", !(await ws("/chat/unread", undefined, O)).json.channels[pid]);

  // ── Threads
  const r1 = await ws(`/chat/channels/${pid}/messages`, { body: "Can we move it to 11?", parentId: m1.id }, M);
  const r2 = await ws(`/chat/channels/${pid}/messages`, { body: "11 works. Decision: 11am, room 4. Maria books the room.", parentId: m1.id }, O);
  check("reply in a thread", r1.status === 201 && r2.status === 201);
  const th = (await ws(`/chat/channels/${pid}/messages?thread=${m1.id}`, undefined, O)).json;
  check("the thread holds the replies in order", th.messages.length === 2 && th.root.replyCount === 2 && th.messages[0].body.startsWith("Can we"));
  const top = (await ws(`/chat/channels/${pid}/messages`, undefined, O)).json.messages as any[];
  const said = top.filter((m) => !m.system);
  check("replies stay out of the channel's main list", said.length === 1 && said[0].replyCount === 2);
  check("the thread starter is notified of a reply", (await ws("/notifications", undefined, O)).json.items.some((n: any) => n.kind === "reply"));
  check("replies to replies are refused (one level of threads)", (await ws(`/chat/channels/${pid}/messages`, { body: "x", parentId: r1.json.message.id }, O)).status === 400);

  // ── Reactions, edit, delete, pins
  const re = await ws(`/chat/messages/${m1.id}/reactions`, { emoji: "👍" }, M);
  check("react with an emoji", re.json.message.reactions.some((r: any) => r.emoji === "👍" && r.users.includes(mid)));
  check("the reaction is delivered over SSE", !!(await sm.waitFor((e) => e.type === "reaction" && e.data.message.id === m1.id)));
  const re2 = await ws(`/chat/messages/${m1.id}/reactions`, { emoji: "👍" }, M);
  check("reacting again removes it", re2.json.message.reactions.length === 0);
  check("edit someone else's message is refused", (await ws(`/chat/messages/${m1.id}`, { body: "hacked" }, M, "PATCH")).status === 403);
  const ed = await ws(`/chat/messages/${r1.json.message.id}`, { body: "Can we move it to 11:30?" }, M, "PATCH");
  check("edit my own message", ed.json.message.body === "Can we move it to 11:30?" && !!ed.json.message.editedAt);
  check("the edit is delivered over SSE", !!(await sm.waitFor((e) => e.type === "message.update" && e.data.message.id === r1.json.message.id && e.data.message.body.endsWith("11:30?"))));
  const pin = await ws(`/chat/messages/${m1.id}`, { pinned: true }, M, "PATCH");
  check("pin a message", pin.json.message.pinned === true);
  check("pinned messages are listed", (await ws(`/chat/channels/${pid}`, undefined, O)).json.pins.some((p: any) => p.id === m1.id));
  const tmp = await ws(`/chat/channels/${pid}/messages`, { body: "oops wrong channel" }, M);
  const otherTmp = await ws(`/chat/channels/${pid}/messages`, { body: "owner's note" }, O);
  check("delete someone else's message is refused", (await ws(`/chat/messages/${otherTmp.json.message.id}`, undefined, M, "DELETE")).status === 403);
  check("…unless you're a chat admin (the owner is)", (await ws(`/chat/messages/${otherTmp.json.message.id}`, undefined, O, "DELETE")).status === 200);
  check("delete my own message", (await ws(`/chat/messages/${tmp.json.message.id}`, undefined, M, "DELETE")).status === 200);
  const after = (await ws(`/chat/channels/${pid}/messages`, undefined, O)).json.messages.find((x: any) => x.id === tmp.json.message.id);
  check("a deleted message keeps its place but loses its text", after?.deleted === true && after.body === "");
  check("an empty message is refused", (await ws(`/chat/channels/${pid}/messages`, { body: "  " }, O)).status === 400);

  // ── Direct messages
  const dm = await ws("/chat/dm", { userId: mid }, O);
  const dm2 = await ws("/chat/dm", { userId: me.id }, M);
  check("a DM is one channel per pair", dm.json.channel.id === dm2.json.channel.id && dm.json.channel.kind === "dm");
  const dmm = await ws(`/chat/channels/${dm.json.channel.id}/messages`, { body: "quick question" }, O);
  check("DMs deliver over SSE and notify", !!(await sm.waitFor((e) => e.type === "message" && e.data.message.id === dmm.json.message.id)) && !!(await sm.waitFor((e) => e.type === "notification" && e.data.notification.kind === "dm")));
  check("an outsider can't open a DM with someone in another workspace", (await ws("/chat/dm", { userId: mid }, X)).status === 404);
  check("…or read this DM", (await ws(`/chat/channels/${dm.json.channel.id}/messages`, undefined, X)).status === 404);

  // ── Search
  const sr = (await ws(`/chat/search?q=${encodeURIComponent("room 4")}`, undefined, M)).json.results as any[];
  check("search finds messages (thread replies too)", sr.some((x) => x.id === r2.json.message.id));
  check("search covers private channels I'm in", (await ws(`/chat/search?q=${encodeURIComponent(`private plans ${tag}`)}`, undefined, M)).json.results.length === 1);
  check("search never shows another workspace's messages", (await ws(`/chat/search?q=Kickoff`, undefined, X)).json.results.length === 0);
  check("search skips deleted messages", (await ws(`/chat/search?q=oops`, undefined, O)).json.results.length === 0);

  // ── Make this a task
  const proj = await ws("/tasks/projects", { name: `${tag} chat tasks`, memberIds: [mid] }, O);
  projectId = proj.json.project.id;
  const mk = await ws(`/chat/messages/${r2.json.message.id}/task`, { projectId, assigneeId: mid }, O);
  check("make a task from a message", mk.status === 201 && mk.json.task.messageId === r2.json.message.id && mk.json.task.title.startsWith("11 works"));
  const td = (await ws(`/tasks/${mk.json.task.id}`, undefined, O)).json.task;
  check("the task links back to the message and quotes it", td.messageId === r2.json.message.id && td.description.includes("Decision: 11am"));
  check("the message shows its task", (await ws(`/chat/messages/${r2.json.message.id}`, undefined, O)).json.message.taskId === mk.json.task.id);
  check("the assignee is notified", (await ws("/notifications", undefined, M)).json.items.some((n: any) => n.kind === "task.assigned"));
  check("an outsider can't turn this message into a task", (await ws(`/chat/messages/${m1.id}/task`, { projectId }, X)).status === 404);

  // ── Summarize this thread (Claude Haiku 5.5)
  const su = await ws(`/chat/messages/${m1.id}/summarize`, {}, O);
  check("summarize a thread with Claude", su.status === 200 && typeof su.json.summary === "string" && su.json.summary.length > 20 && /11/.test(su.json.summary), su.json.error ?? su.status);
  check("a message with no replies has nothing to summarize", (await ws(`/chat/messages/${pp.json.message.id}/summarize`, {}, O)).status === 400);

  check("the stream sends a heartbeat within ~20s", await hb);

  // ── Isolation
  check("an outsider can't read, post, react, edit or pin here", (await ws(`/chat/channels/${pid}/messages`, undefined, X)).status === 404 && (await ws(`/chat/channels/${pid}/messages`, { body: "hi" }, X)).status === 404 && (await ws(`/chat/messages/${m1.id}/reactions`, { emoji: "👍" }, X)).status === 404 && (await ws(`/chat/messages/${m1.id}`, { pinned: false }, X, "PATCH")).status === 404);
  check("an outsider's channel list has none of these channels", !(await ws("/chat/channels", undefined, X)).json.channels.some((c: any) => c.id === pid || c.id === privId));

  // ── Permissions
  await setMemberPerm({ "teamchat.private": false });
  const M2 = await signIn(MEMBER, "teamchat");
  check("without “Create private channels”, a private channel is refused", (await ws("/chat/channels", { name: `${tag}-p2`, kind: "private" }, M2)).status === 403);
  const pubOk = await ws("/chat/channels", { name: `${tag}-m-pub` }, M2);
  check("…but a public one is fine", pubOk.status === 201);
  await setMemberPerm({ "teamchat.channel.create": false, "teamchat.ai": false });
  const M3 = await signIn(MEMBER, "teamchat");
  check("without “Create channels”, creating one is refused", (await ws("/chat/channels", { name: `${tag}-m2` }, M3)).status === 403);
  check("without “Summarize threads with AI”, summaries are refused", (await ws(`/chat/messages/${m1.id}/summarize`, {}, M3)).status === 403);
  await setMemberPerm({ "teamchat.open": false });
  check("without Team Chat, no pass is issued for it", await signIn(MEMBER, "teamchat").then(() => false, () => true));
  check("…and the API refuses them", (await ws("/chat/channels", undefined, await signIn(MEMBER, "tasks"))).status === 403);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  for (const s of streams) s.close();
  await resetMember().catch(() => {});
  if (projectId) await ws(`/tasks/projects/${projectId}`, { archived: true }, O, "PATCH").catch(() => {});
  // Remove this run's channels (and their messages) so the sidebar stays clean.
  const dbc = new pg.Client({ connectionString: envOf(new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")).DATABASE_URL });
  await dbc.connect();
  await dbc.query(`delete from channels where name like $1`, [`${tag}-%`]);
  await dbc.end();
}
process.exit(summary("Chat") ? 1 : 0);
