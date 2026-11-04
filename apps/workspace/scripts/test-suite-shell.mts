/**
 * Calendar, Tasks and Chat as suite modules: the suite shell around every page
 * (GET /api/iotx/shell), one bell (POST /api/iotx/notify, Workspace forwards
 * its notifications), Mail context for meeting prep (POST /api/iotx/context:
 * only the person's own mailboxes), search, the sidebar list, and pages
 * inside the suite's tabs (the suite is a browser; see web components/iotx/browser).
 *   npx tsx scripts/test-suite-shell.mts <devToken> <test-users.json>
 */
import pg from "pg";
import { check, envOf, OUTSIDER, OWNER, setup, signIn, sleep, summary, suite, ws, WS, SUITE } from "./lib.mts";

const here = (p: string) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const KEY = envOf(here("../.env")).IOTX_SERVICE_KEY;
const WEB_DB = envOf(here("../../../web/.env")).DATABASE_URL;
const { wsId, MEMBER } = await setup();
const tag = `S${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: WEB_DB });
await db.connect();
const cleanup: (() => Promise<unknown>)[] = [];

const call = async (path: string, init: { method?: string; body?: unknown; key?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (init.key !== null) headers["x-iotx-key"] = init.key ?? KEY;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${SUITE}${path}`, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

try {
  const O = await signIn(OWNER);
  const M = await signIn(MEMBER, "tasks");
  const me = (await ws("/me", undefined, O)).json.me;
  const mm = (await ws("/me", undefined, M)).json.me;

  // ── GET /api/iotx/shell
  check("shell: no key -> 403", (await call(`/api/iotx/shell?userId=${me.id}`, { key: null })).status === 403);
  check("shell: wrong key -> 403", (await call(`/api/iotx/shell?userId=${me.id}`, { key: "nope" })).status === 403);
  check("shell: a key of the wrong length -> 403 (no timing leak path throws)", (await call(`/api/iotx/shell?userId=${me.id}`, { key: KEY + "x" })).status === 403);
  check("shell: userId is required", (await call(`/api/iotx/shell`)).status === 400);
  check("shell: a workspace the person isn't in -> 404", (await call(`/api/iotx/shell?userId=${me.id}&ws=not-a-workspace`)).status === 404);
  const sh = await call(`/api/iotx/shell?userId=${me.id}&ws=${wsId}`);
  const s = sh.json;
  check("shell: 200 with user, perms, appearance, workspace, recent chats", sh.status === 200 && s.shell?.user?.email === "dev@localhost" && Array.isArray(s.shell?.perms?.apps) && !!s.shell?.appearance?.theme && s.shell?.workspace?.id === wsId && Array.isArray(s.shell?.recentChats), sh.status);
  check("shell: paint palettes for light and dark (first paint)", !!s.paint?.palettes?.light?.["--accent"] && !!s.paint?.palettes?.dark?.["--accent"]);
  check("shell: brand comes with it", typeof s.brand?.name === "string" && typeof s.brand?.shortName === "string");
  const app = (id: string) => (s.apps as { id: string; name: string; href: string; status: string }[]).find((a) => a.id === id);
  check("shell: Calendar is a live app at /workspace/calendar", app("calendar")?.href === "/workspace/calendar" && app("calendar")?.status === "live" && app("calendar")?.name === "Calendar");
  check("shell: Tasks is a live app at /workspace/tasks", app("tasks")?.href === "/workspace/tasks" && app("tasks")?.name === "Tasks");
  check("shell: team chat is called “Chat” at /workspace/chat; the AI chat is “AI Chat”", app("teamchat")?.href === "/workspace/chat" && app("teamchat")?.name === "Chat" && app("chat")?.name === "AI Chat");
  check("shell: the sidebar lists Chat, Calendar and Tasks", ["teamchat", "calendar", "tasks"].every((x) => (s.sidebar as string[]).includes(x)));
  check("shell: no app is named “Workspace”", !(s.apps as { name: string }[]).some((a) => /workspace/i.test(a.name)));
  const shM = (await call(`/api/iotx/shell?userId=${mm.id}&ws=${wsId}`)).json;
  check("shell: follows the person's permissions (member has no Admin, owner can manage)", s.shell.perms.canManage === true && shM.shell?.perms?.canManage === false);

  // ── Pages show inside the suite's tabs (the suite is a browser): no chrome of their own inside a
  // tab, and opened on their own they go into the suite's frame as a tab
  for (const [path, label] of [["/calendar", "Calendar"], ["/tasks", "Tasks"], ["/chat", "Chat"], ["/meet", "Meet"]] as const) {
    const r = await fetch(`${WS}${path}`, { headers: { cookie: O, "sec-fetch-dest": "iframe" } });
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    check(`${label} page in a tab: the page on the account's canvas, with no bar, sidebar or launcher of its own`, r.status === 200 && html.includes("ix-approot") && !html.includes('class="ix-appbar"') && !html.includes('class="ix-side"') && !html.includes("ixb-") && !html.includes("data-launcher") && !/Search or ask/.test(text));
    check(`${label} page: no “Workspace” anywhere a person can read`, !/\bWorkspace\b/.test(text) && !/<title>[^<]*Workspace/.test(html), text.match(/.{30}\bWorkspace\b.{30}/)?.[0]);
    check(`${label} page: no second bar, so the app has the whole tab`, !/["\s]ws-side["\s]/.test(html) && !/["\s]ws-topbar["\s]/.test(html));
    check(`${label} page: may be framed only by the suite (same origin)`, r.headers.get("x-frame-options") === "SAMEORIGIN" && /frame-ancestors 'self'/.test(r.headers.get("content-security-policy") ?? ""));
    const top = await (await fetch(`${WS}${path}?x=1`, { headers: { cookie: O, "sec-fetch-dest": "document" } })).text();
    check(`${label} page opened on its own: goes into the suite's frame as a tab (/tab?u=…, query kept)`, top.includes(`location.replace(${JSON.stringify(SUITE)}+"/tab?u="+encodeURIComponent(location.pathname+location.search+location.hash))`) && !top.includes("ix-approot"));
  }
  const title = (await (await fetch(`${WS}/calendar`, { headers: { cookie: O } })).text()).match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  check("page title is “Calendar · <suite name>”", title.startsWith("Calendar · "), title);
  check("the appearance is written before paint (theme + palette)", (await (await fetch(`${WS}/tasks`, { headers: { cookie: O } })).text()).includes("iotx-paint"));

  // ── Theme menu saves to the suite account
  const before = s.shell.appearance.theme as string;
  const want = before === "dark" ? "light" : "dark";
  const ap = await ws("/suite/appearance", { theme: want }, O);
  const after = (await call(`/api/iotx/shell?userId=${me.id}&ws=${wsId}`)).json.shell.appearance.theme;
  check("theme menu: saved to the suite account", ap.status === 200 && ap.json.appearance?.theme === want && after === want);
  await ws("/suite/appearance", { theme: before }, O);
  check("appearance save needs a session", (await ws("/suite/appearance", { theme: "dark" })).status === 401);

  // ── POST /api/iotx/notify (one bell)
  check("notify: no key -> 403", (await call("/api/iotx/notify", { key: null, body: { userId: me.id, title: "x", href: "/workspace/calendar" } })).status === 403);
  check("notify: an outside href is refused", (await call("/api/iotx/notify", { body: { userId: me.id, title: "x", href: "https://evil.example" } })).status === 400);
  check("notify: a protocol-relative href is refused", (await call("/api/iotx/notify", { body: { userId: me.id, title: "x", href: "//evil.example" } })).status === 400);
  check("notify: title is required", (await call("/api/iotx/notify", { body: { userId: me.id, href: "/workspace/calendar" } })).status === 400);
  check("notify: unknown user -> 404", (await call("/api/iotx/notify", { body: { userId: "nobody", title: "x", href: "/workspace/calendar" } })).status === 404);
  const n1 = await call("/api/iotx/notify", { body: { userId: me.id, title: `${tag} Event moved`, body: "Tomorrow 10:00", href: "/workspace/calendar?event=e1", kind: "workspace.test" } });
  check("notify: 201 with an id", n1.status === 201 && !!n1.json.id);
  cleanup.push(() => db.query(`DELETE FROM notifications WHERE title LIKE $1`, [`${tag}%`]));
  const bell = (await suite("/api/notifications")).json;
  const mine = (bell.items as { id: string; title: string; href: string; readAt: string | null }[]).find((i) => i.id === n1.json.id);
  check("the suite bell shows it, with its /workspace link", mine?.title === `${tag} Event moved` && mine?.href === "/workspace/calendar?event=e1" && !mine?.readAt);
  const wsBell = (await ws("/suite/notifications", undefined, O)).json;
  check("Calendar/Tasks/Chat pages show the same bell (through this app)", (wsBell.items as { id: string }[]).some((i) => i.id === n1.json.id) && typeof wsBell.unread === "number");
  await ws("/suite/notifications", { ids: [n1.json.id] }, O);
  const readNow = ((await suite("/api/notifications")).json.items as { id: string; readAt: string | null }[]).find((i) => i.id === n1.json.id);
  check("marking read from a Workspace page marks it in the suite", !!readNow?.readAt);
  check("the bell proxy needs a session", (await ws("/suite/notifications")).status === 401);

  // Workspace sends its own notifications to the suite bell
  const ev = await ws("/calendar/events", { title: `${tag} Bell invite`, start: new Date(Date.now() + 5 * 86_400_000).toISOString(), end: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString(), attendees: [{ userId: mm.id }] }, O);
  cleanup.push(() => ws(`/calendar/events/${ev.json.event?.id}`, undefined, O, "DELETE"));
  let got: { title: string; href: string; body: string | null } | undefined;
  for (let i = 0; i < 20 && !got; i++) {
    await sleep(250);
    got = ((await suite("/api/notifications", undefined, MEMBER)).json.items as { title: string; href: string; body: string | null }[]).find((x) => x.title.includes(`${tag} Bell invite`));
  }
  check("an invite from Calendar reaches the invitee's suite bell", !!got && got.href === `/workspace/calendar?event=${ev.json.event?.id}`, got);
  check("…with the start time as words, not an ISO string", !!got?.body && !/T\d\d:\d\d:\d\d/.test(got.body), got?.body);

  // ── POST /api/iotx/context (Mail for meeting prep)
  check("context: no key -> 403", (await call("/api/iotx/context", { key: null, body: { userId: me.id, query: "x" } })).status === 403);
  const box = async (owner: string, email: string) => {
    const id = `${tag}-${email.split("@")[0]}`;
    await db.query(
      `INSERT INTO mailboxes (id, "workspaceId", "ownerId", email, "imapHost", "smtpHost", username, secret, status, "createdById", "updatedAt") VALUES ($1,$2,$3,$4,'imap.test','smtp.test',$4,'{}'::jsonb,'ok',$3,now())`,
      [id, wsId, owner, email],
    );
    return id;
  };
  const myBox = await box(me.id, `${tag.toLowerCase()}-dev@iotx.test`);
  const theirBox = await box(mm.id, `${tag.toLowerCase()}-member@iotx.test`);
  cleanup.push(() => db.query(`DELETE FROM mailboxes WHERE id = ANY($1)`, [[myBox, theirBox]]));
  const msg = (boxId: string, uid: number, subject: string, from: string) =>
    db.query(`INSERT INTO mail_messages (id, "mailboxId", folder, uid, "fromAddr", "fromName", "to", subject, snippet, date) VALUES ($1,$2,'INBOX',$3,$4,'Sender','[]'::jsonb,$5,$6, now() - interval '1 day')`, [`${tag}-m${uid}`, boxId, uid, from, subject, `About ${subject}`]);
  await msg(myBox, 1, `${tag} Zephyr pricing proposal`, "priya@client.test");
  await msg(myBox, 2, "Lunch?", "ravi@client.test");
  await msg(theirBox, 3, `${tag} Zephyr pricing secret`, "boss@client.test");
  const ctx = await call("/api/iotx/context", { body: { userId: me.id, ws: wsId, query: "Zephyr pricing review" } });
  const subjects = (ctx.json.messages as { subject: string }[] | undefined)?.map((m) => m.subject) ?? [];
  check("context: finds the person's own matching mail", ctx.status === 200 && subjects.includes(`${tag} Zephyr pricing proposal`), ctx.json);
  check("context: never returns someone else's mailbox", !subjects.includes(`${tag} Zephyr pricing secret`));
  check("context: subject, from, date and snippet only (no bodies)", ctx.json.messages?.every((m: Record<string, unknown>) => m.subject !== undefined && m.from && m.date && "snippet" in m && !("html" in m) && !("text" in m)));
  const byFrom = await call("/api/iotx/context", { body: { userId: me.id, ws: wsId, query: "", emails: ["ravi@client.test"] } });
  check("context: matches mail from a meeting's guests", (byFrom.json.messages as { subject: string }[]).some((m) => m.subject === "Lunch?"));
  const asMember = await call("/api/iotx/context", { body: { userId: mm.id, ws: wsId, query: "Zephyr pricing" } });
  check("context: the member sees only their own", (asMember.json.messages as { subject: string }[]).every((m) => m.subject !== `${tag} Zephyr pricing proposal`) && (asMember.json.messages as { subject: string }[]).some((m) => m.subject === `${tag} Zephyr pricing secret`));
  check("context: a workspace they're not in -> 404", (await call("/api/iotx/context", { body: { userId: me.id, ws: "nope", query: "x" } })).status === 404);

  // ── Top-bar search
  const sr = (await ws(`/search?q=${encodeURIComponent(`${tag} Bell`)}`, undefined, O)).json;
  check("search: finds events (with a /workspace link)", sr.events?.some((e: { title: string; href: string }) => e.title === `${tag} Bell invite` && e.href.startsWith("/workspace/calendar?event=")));
  check("search: needs a session", (await ws("/search?q=x")).status === 401);
  const srX = (await ws(`/search?q=${encodeURIComponent(`${tag} Bell`)}`, undefined, await signIn(OUTSIDER))).json;
  check("search: other workspaces see nothing", !srX.events?.length);
} finally {
  for (const f of cleanup.reverse()) await f().catch(() => {});
  await db.end();
}

process.exit(summary("suite shell") ? 1 : 0);
