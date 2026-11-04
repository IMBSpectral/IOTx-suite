import { db } from "../db";
import type { Me } from "../auth";
import { EMAIL_ORIGIN } from "../env";
import { ownedBy } from "./insights";
import { readPrefs, reportHref, visibleReports, whenOf } from "./read";
import { meFor } from "./recommend";

/**
 * The Daily Read (helper B): a morning digest per person (opt-in in Meet
 * settings): yesterday's meetings with a summary line, their open action
 * items, and today's meetings with prep links. Emailed through the suite
 * mail route Calendar uses, once per local day, and shown in the app.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const localDay = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const localHour = (d: Date, tz: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d)) % 24;
const time = (d: Date | string, tz: string) => new Date(d).toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" });

export type Digest = {
  day: string;
  yesterday: { code: string; title: string; at: string; line: string; href: string }[];
  actions: { code: string; meeting: string; title: string; due: string; href: string }[];
  today: { id: string; title: string; start: string; end: string; join: string | null; prep: string }[];
};

/** Build the digest for a person and local day (no side effects). */
export async function buildDigest(me: Me, now = new Date()): Promise<Digest> {
  const tz = me.tz || "UTC";
  const { dayWindow, addDaysStr } = await import("../cal-smart");
  const day = localDay(now, tz);
  const today = dayWindow(day, tz);
  const yesterday = dayWindow(addDaysStr(day, -1), tz);
  const yReps = await visibleReports(me, { from: yesterday.start, to: yesterday.end });
  const recent = await visibleReports(me, { from: new Date(today.start.getTime() - 14 * 86_400_000), to: today.end });
  const done = new Set((await db.readActionTask.findMany({ where: { meetingId: { in: recent.map((x) => x.m.id) } } })).map((t) => `${t.meetingId}:${t.idx}`));
  // Items already turned into tasks count as open only while the task is.
  const tasks = await db.readActionTask.findMany({ where: { meetingId: { in: recent.map((x) => x.m.id) } } });
  const closed = new Set((await db.task.findMany({ where: { id: { in: tasks.map((t) => t.taskId) }, completedAt: { not: null } }, select: { id: true } })).map((t) => t.id));
  const actions = recent.flatMap(({ m, r }) =>
    r.actionItems
      .map((a, i) => ({ a, i }))
      .filter(({ a, i }) => ownedBy(a.owner, me) && !(done.has(`${m.id}:${i}`) && closed.has(tasks.find((t) => t.meetingId === m.id && t.idx === i)?.taskId ?? "")))
      .map(({ a }) => ({ code: m.code, meeting: m.title, title: a.title, due: a.due, href: `${EMAIL_ORIGIN}${reportHref(m.code, a.start)}` })),
  );
  let todayList: Digest["today"] = [];
  if (me.perms["calendar.open"]) {
    const { occurrences } = await import("../calendar");
    const occ = await occurrences(me, today.start, today.end).catch(() => []);
    todayList = occ
      .filter((o) => !o.allDay && o.eventType === "default" && !o.masked && o.myResponse !== "no" && (o.attendees.length > 0 || o.conferenceUrl))
      .map((o) => ({ id: o.id, title: o.title, start: o.start, end: o.end, join: o.conferenceUrl, prep: `${EMAIL_ORIGIN}/workspace/calendar?event=${o.id}&prep=1` }));
  }
  return {
    day,
    yesterday: yReps.map(({ m, r }) => ({ code: m.code, title: m.title, at: whenOf(m).toISOString(), line: r.summary.split(/(?<=[.!?])\s/)[0]?.slice(0, 300) ?? "", href: `${EMAIL_ORIGIN}${reportHref(m.code)}` })),
    actions: actions.slice(0, 20),
    today: todayList,
  };
}

export function renderDigest(d: Digest, name: string, tz: string) {
  const subject = `Your Daily Read for ${new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}`;
  const text = [
    `Good morning, ${name.split(" ")[0]}.`,
    "",
    "YESTERDAY'S MEETINGS",
    ...(d.yesterday.length ? d.yesterday.map((y) => `• ${y.title}: ${y.line}\n  ${y.href}`) : ["• No meeting reports from yesterday."]),
    "",
    "YOUR OPEN ACTION ITEMS",
    ...(d.actions.length ? d.actions.map((a) => `• ${a.title}${a.due ? ` (due ${a.due})` : ""} — from ${a.meeting}\n  ${a.href}`) : ["• Nothing open for you."]),
    "",
    "TODAY",
    ...(d.today.length ? d.today.map((t) => `• ${time(t.start, tz)} ${t.title}\n  Prepare: ${t.prep}${t.join ? `\n  Join: ${t.join}` : ""}`) : ["• No meetings today."]),
    "",
    "Turn this email off in Meet → Settings.",
  ].join("\n");
  const sec = (title: string, body: string) => `<h3 style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6a6e8a;margin:22px 0 8px">${title}</h3>${body}`;
  const li = (inner: string) => `<li style="margin:0 0 10px">${inner}</li>`;
  const ul = (items: string[], empty: string) => (items.length ? `<ul style="padding-left:18px;margin:0">${items.join("")}</ul>` : `<p style="color:#6a6e8a;margin:0">${empty}</p>`);
  const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:14px;color:#14152b;max-width:600px">
<h2 style="margin:0 0 4px;font-size:20px">Your Daily Read</h2>
<p style="color:#6a6e8a;margin:0">Good morning, ${esc(name.split(" ")[0])}.</p>
${sec("Yesterday's meetings", ul(d.yesterday.map((y) => li(`<a href="${esc(y.href)}" style="font-weight:600;color:#4f46e5">${esc(y.title)}</a><br>${esc(y.line)}`)), "No meeting reports from yesterday."))}
${sec("Your open action items", ul(d.actions.map((a) => li(`${esc(a.title)}${a.due ? ` <span style="color:#b45309">(due ${esc(a.due)})</span>` : ""}<br><a href="${esc(a.href)}" style="color:#6a6e8a;font-size:12px">from ${esc(a.meeting)}</a>`)), "Nothing open for you."))}
${sec("Today", ul(d.today.map((t) => li(`<b>${esc(time(t.start, tz))}</b> ${esc(t.title)}<br><a href="${esc(t.prep)}" style="color:#4f46e5">Prepare</a>${t.join ? ` · <a href="${esc(t.join)}" style="color:#4f46e5">Join</a>` : ""}`)), "No meetings today."))}
<p style="color:#6a6e8a;font-size:12px;margin-top:24px">Turn this email off in Meet → Settings.</p>
</div>`;
  return { subject, text, html };
}

/** The digest to show in the app: today's saved one, else a fresh preview. */
export async function dailyFor(me: Me) {
  const day = localDay(new Date(), me.tz || "UTC");
  const saved = await db.readDigest.findUnique({ where: { userId_day: { userId: me.userId, day } } });
  if (saved) return { day, data: saved.data as unknown as Digest, emailedAt: saved.emailedAt, saved: true };
  return { day, data: await buildDigest(me), emailedAt: null, saved: false };
}

/** Send one person's digest now (once per local day). */
export async function sendDigest(me: Me, now = new Date()) {
  const d = await buildDigest(me, now);
  const exists = await db.readDigest.findUnique({ where: { userId_day: { userId: me.userId, day: d.day } } });
  if (exists?.emailedAt) return { sent: false, day: d.day };
  const { subject, text, html } = renderDigest(d, me.name, me.tz || "UTC");
  const row = await db.readDigest.upsert({
    where: { userId_day: { userId: me.userId, day: d.day } },
    create: { ws: me.ws, userId: me.userId, day: d.day, subject, text, html, data: d as never },
    update: { subject, text, html, data: d as never },
  });
  const { sendMail } = await import("../cal-mail");
  const ok = await sendMail({ to: me.email, subject, text, html, fromName: "Daily Read" });
  if (ok) await db.readDigest.update({ where: { id: row.id }, data: { emailedAt: new Date() } });
  return { sent: ok, day: d.day };
}

/** Every ~10 minutes: people who opted in, at or after their hour, who haven't had today's digest. */
export async function dailyTick(now = new Date()) {
  const prefs = await db.readPrefs.findMany({ where: { dailyRead: true } });
  let sent = 0;
  for (const p of prefs) {
    const me = await meFor(p.userId, p.ws);
    if (!me || !me.perms["meetings.open"]) continue;
    const tz = me.tz || "UTC";
    if (localHour(now, tz) < p.dailyHour) continue;
    const day = localDay(now, tz);
    const had = await db.readDigest.findUnique({ where: { userId_day: { userId: me.userId, day } } });
    if (had?.emailedAt) continue;
    const r = await sendDigest(me, now).catch((e) => (console.error("daily read", e), { sent: false }));
    if (r.sent) sent++;
  }
  return sent;
}

export { readPrefs };
