import { db } from "./db";
import { expand } from "./rrule";
import { notify } from "./notify";
import { syncUser } from "./google";

/**
 * Background work in the server process:
 *  - every 60s, Google Calendar sync for anyone who opened Calendar in the last 15 minutes;
 *  - every 30s, event reminders as in-app notifications;
 *  - repeating Tasks issues and "due tomorrow" notices.
 */

async function googleTick() {
  const since = new Date(Date.now() - 15 * 60_000);
  const users = await db.user.findMany({ where: { calendarSeenAt: { gt: since } }, select: { id: true } });
  for (const u of users) {
    const st = await db.googleSync.findUnique({ where: { userId: u.id } });
    if (!st || st.error === "reconnect") continue; // they haven't turned sync on, or must reconnect
    const s = await db.session.findFirst({ where: { userId: u.id, ws: st.ws }, orderBy: { permsAt: "desc" } });
    if (!s || !(s.perms as Record<string, boolean>)["calendar.google"]) continue;
    await syncUser(u.id, st.ws).catch(() => {});
  }
}

let lastReminder = Date.now() - 60_000;
export async function reminderTick(now = Date.now(), fromOverride?: number) {
  const from = fromOverride ?? lastReminder;
  if (fromOverride === undefined) lastReminder = now;
  const horizon = new Date(now + 7 * 86_400_000);
  const evs = await db.event.findMany({ where: { deletedAt: null, NOT: { reminders: { isEmpty: true } } }, include: { attendees: true } });
  let sent = 0;
  for (const e of evs) {
    const maxMin = Math.max(...e.reminders);
    const occ = e.rrule ? expand(e, new Date(from), new Date(Math.min(horizon.getTime(), now + maxMin * 60_000 + 60_000))) : [e.start];
    for (const s of occ) {
      for (const min of e.reminders) {
        const at = s.getTime() - min * 60_000;
        if (at <= from || at > now) continue;
        const who = new Set<string>([e.creatorId, ...e.attendees.filter((a) => a.userId && a.response !== "no").map((a) => a.userId!)]);
        const when = min === 0 ? "now" : min < 60 ? `in ${min} min` : min < 1440 ? `in ${min / 60} h` : `in ${Math.round(min / 1440)} day(s)`;
        for (const uid of who) {
          if (!uid) continue;
          const r = await notify({ ws: e.ws, userId: uid, kind: "reminder", title: `${e.title} starts ${when}`, body: s.toISOString(), link: `/calendar?event=${e.id}`, key: `rem:${e.id}:${s.getTime()}:${min}:${uid}` });
          if (r) sent++;
        }
      }
    }
  }
  return sent;
}

export function startJobs() {
  const g = globalThis as unknown as { __iotxJobs?: boolean };
  if (g.__iotxJobs) return;
  g.__iotxJobs = true;
  setInterval(() => googleTick().catch((e) => console.error("google tick", e)), 60_000).unref?.();
  setInterval(() => reminderTick().catch((e) => console.error("reminder tick", e)), 30_000).unref?.();
  // Calendar: email reminders every minute, subscribed calendars refreshed every 30 minutes (each one at most every 6 hours).
  setInterval(() => import("./cal-plus").then((m) => m.emailReminderTick()).catch((e) => console.error("email reminders", e)), 60_000).unref?.();
  setInterval(() => import("./cal-plus").then((m) => m.refreshSubscriptions()).catch((e) => console.error("ics refresh", e)), 30 * 60_000).unref?.();
  // Tasks: repeating issues every minute, "due tomorrow" heads-ups every 15 minutes (each sent once).
  setInterval(() => import("./tasks-plan").then((m) => m.recurringTick()).catch((e) => console.error("recurring tasks", e)), 60_000).unref?.();
  setInterval(() => import("./tasks-plan").then((m) => m.dueSoonTick()).catch((e) => console.error("due soon", e)), 15 * 60_000).unref?.();
  // Meet: recordings past their retention period or over the workspace's storage cap, hourly.
  setInterval(() => import("./meet/recording").then((m) => m.retentionTick()).catch((e) => console.error("meet retention", e)), 60 * 60_000).unref?.();
  // Meet: "report ready" integrations (webhooks, Chat, Tasks, knowledge base, calendar, email recap), every 20 seconds.
  setInterval(() => import("./meet/integrations").then((m) => m.integrationsTick()).catch((e) => console.error("meet integrations", e)), 20_000).unref?.();
  // Meet across meetings: the Daily Read every 10 minutes (once per person per local day), Flexible meetings every 15.
  setInterval(() => import("./meet/daily").then((m) => m.dailyTick()).catch((e) => console.error("daily read", e)), 10 * 60_000).unref?.();
  setInterval(() => import("./meet/recommend").then((m) => m.flexTick()).catch((e) => console.error("flexible meetings", e)), 15 * 60_000).unref?.();
  // Chat: scheduled messages, "remind me" on saved items, retention, unread-mention emails.
  setInterval(() => import("./chat").then((m) => m.chatTick()).catch((e) => console.error("chat tick", e)), 30_000).unref?.();
}
