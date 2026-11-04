import { db } from "./db";
import { publish } from "./bus";
import { suiteCall } from "./suite";
import { inDnd, isOnline, prefsOf } from "./presence";
import { pushTo } from "./push";

/**
 * A notification. Kept here (once-only `key`s for reminders, the live event
 * on this app's stream) and sent to the suite's bell (POST /api/iotx/notify),
 * so there is one bell for every app. Links are sent as /workspace/... paths,
 * which open from any suite page. When no Workspace tab is open (and not in
 * do-not-disturb), it is also pushed to the person's subscribed devices.
 * Bots ("bot_…") have no bell: they get events at their own URL instead.
 */
export async function notify(n: { ws: string; userId: string; kind: string; title: string; body?: string; link?: string; key?: string }) {
  if (n.userId.startsWith("bot_")) return null;
  let row;
  try {
    row = await db.notification.create({ data: { ws: n.ws, userId: n.userId, kind: n.kind, title: n.title.slice(0, 200), body: (n.body ?? "").slice(0, 500), link: n.link ?? "", key: n.key } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return null; // already sent
    throw e;
  }
  if (!n.userId.startsWith("guest_")) void toSuite(n).catch(() => {});
  void pushIfAway(n).catch(() => {});
  publish(`user:${n.userId}`, { type: "notification", notification: row });
  return row;
}

/** Reminders and invites carry an ISO start in `body`: the suite shows it as words, in the person's zone. */
async function toSuite(n: { userId: string; kind: string; title: string; body?: string; link?: string }) {
  let body = n.body ?? "";
  if ((n.kind === "reminder" || n.kind === "invite") && /^\d{4}-\d\d-\d\dT/.test(body)) {
    const u = await db.user.findUnique({ where: { id: n.userId }, select: { tz: true } });
    body = new Date(body).toLocaleString("en-IN", { timeZone: u?.tz || "UTC", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }
  const href = n.link ? (n.link.startsWith("/workspace") ? n.link : `/workspace${n.link}`) : "/workspace/calendar";
  await suiteCall("/api/iotx/notify", { body: { userId: n.userId, title: n.title, body, href, kind: `workspace.${n.kind}`.slice(0, 40) } });
}

async function pushIfAway(n: { ws: string; userId: string; kind: string; title: string; body?: string; link?: string }) {
  if (isOnline(n.ws, n.userId)) return;
  const u = await db.user.findUnique({ where: { id: n.userId }, select: { chatPrefs: true, tz: true } });
  const p = prefsOf(u?.chatPrefs);
  if (p.push === false || inDnd(p)) return;
  if (!(await db.pushSub.count({ where: { userId: n.userId } }))) return;
  const iso = /^\d{4}-\d\d-\d\dT/.test(n.body ?? "");
  const body = iso ? new Date(n.body!).toLocaleString("en-IN", { timeZone: u?.tz || "UTC", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : n.body;
  const url = n.link ? (n.link.startsWith("/workspace") ? n.link : `/workspace${n.link}`) : "/workspace/calendar";
  await pushTo(n.userId, { title: n.title, body, url, tag: n.kind });
}
