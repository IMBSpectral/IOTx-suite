import crypto from "node:crypto";
import type { Meeting, MeetWebhook } from "@prisma/client";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad, str } from "../http";
import { callApp, urlOk } from "../chat-apps";
import { loadChannel, postMessage } from "../chat";
import { loadProject } from "../tasks";
import { canEditEvent, loadEvent } from "../calendar";
import { suiteCall } from "../suite";
import { notesText, notesToTasks, type MeetingNotes } from "./notes";
import { reportUrl } from "./external";

/**
 * "Report ready → elsewhere" (Meet → Integrations), per person, for the
 * meetings they host (including calls captured by the browser extension):
 *  - webhooks out: report.ready with the report as JSON, signed exactly like
 *    Chat's bots (x-iotx-timestamp, x-iotx-signature = "v0=" +
 *    HMAC-SHA256(secret, "v0:<ts>:<body>")) and sent through Chat's
 *    SSRF-safe callApp; a test delivery and a delivery log;
 *  - post the summary in a Chat channel;
 *  - action items become tasks in a Tasks project (notes-to-tasks);
 *  - decisions go to the knowledge base's review queue (suite /api/iotx/kb, suggest);
 *  - the calendar event's description gets the summary and a link;
 *  - an email recap to attendees, invitees or only me (suite mail route).
 * It runs once per report version (the meeting's notesAt), from the
 * extension's finish and from a 20-second job for every other meeting.
 */

export type Report = {
  version: 2;
  summary: string;
  actionItems: { title: string; owner: string; due: string; start: number | null }[];
  decisions: string[];
  topics?: string[];
  [k: string]: unknown;
};

export const RECAP_RULES = ["off", "workspace", "attendees", "invitees", "me"] as const;

/** The notes shape, from the meeting's notes or (if only that exists) its v2 report. */
export function notesFor(m: Meeting): MeetingNotes | null {
  const n = m.notes as MeetingNotes | null;
  if (n && typeof n.summary === "string") return { summary: n.summary, decisions: n.decisions ?? [], actionItems: n.actionItems ?? [] };
  const r = m.report as Report | null;
  if (r && typeof r.summary === "string") return { summary: r.summary, decisions: r.decisions ?? [], actionItems: (r.actionItems ?? []).map((a) => ({ title: a.title, owner: a.owner, due: a.due })) };
  return null;
}

/** A person as a Me for background work: their latest Workspace session's permissions. */
export async function meFor(ws: string, userId: string): Promise<Me | null> {
  const s = await db.session.findFirst({ where: { userId, ws, guest: false }, orderBy: { permsAt: "desc" } });
  const u = await db.user.findUnique({ where: { id: userId } });
  if (!s || !u) return null;
  return { sid: `job:${userId}`, userId, ws, name: u.name ?? u.email, email: u.email, tz: u.tz, owner: s.owner, perms: s.perms as Record<string, boolean>, stale: false, guest: false };
}

// ── Settings ───────────────────────────────────────────────────────────────

async function settingsRow(me: Me) {
  return (await db.meetIntegration.findUnique({ where: { ws_userId: { ws: me.ws, userId: me.userId } } })) ?? { chatChannelId: null, tasksProjectId: null, kbSuggest: false, calendarWriteback: false, emailRecap: "off" };
}

/** Meet's sharing setting (who gets recaps, helper B's read.ts), with its default when it can't be read. */
async function workspaceRecap(ws: string): Promise<string> {
  const { readSettings } = await import("./read");
  return (await readSettings(ws).catch(() => ({ recapTo: "attendees" }))).recapTo;
}

const deliveryDto = (d: { id: string; meetingId: string | null; webhookId: string | null; target: string; event: string; ok: boolean; status: number; detail: string; ms: number; test: boolean; createdAt: Date }) => d;
const hookDto = (h: MeetWebhook) => ({ id: h.id, url: h.url, events: h.events, active: h.active, createdAt: h.createdAt, secretHint: `${h.secret.slice(0, 10)}…` });

export async function getIntegrations(me: Me) {
  const s = await settingsRow(me);
  const hooks = await db.meetWebhook.findMany({ where: { ws: me.ws, userId: me.userId }, orderBy: { createdAt: "asc" } });
  const log = await db.meetDelivery.findMany({ where: { ws: me.ws, userId: me.userId }, orderBy: { createdAt: "desc" }, take: 50 });
  const titles = new Map((await db.meeting.findMany({ where: { id: { in: [...new Set(log.map((l) => l.meetingId).filter((x): x is string => !!x))] } }, select: { id: true, title: true, code: true } })).map((m) => [m.id, m]));
  return {
    settings: { chatChannelId: s.chatChannelId, tasksProjectId: s.tasksProjectId, kbSuggest: s.kbSuggest, calendarWriteback: s.calendarWriteback, emailRecap: s.emailRecap },
    workspaceRecap: await workspaceRecap(me.ws),
    webhooks: hooks.map(hookDto),
    deliveries: log.map((d) => ({ ...deliveryDto(d), meeting: d.meetingId ? titles.get(d.meetingId) ?? null : null })),
  };
}

export async function saveIntegrations(me: Me, b: { chatChannelId?: string | null; tasksProjectId?: string | null; kbSuggest?: boolean; calendarWriteback?: boolean; emailRecap?: string }) {
  const data: Record<string, unknown> = {};
  if (b.chatChannelId !== undefined) {
    if (b.chatChannelId) {
      if (!can(me, "teamchat.open")) throw new HttpError(403, "Your role can't use Team Chat.", { key: "teamchat.open" });
      const { ch, member } = await loadChannel(me, String(b.chatChannelId));
      if (!member || ch.kind === "dm") bad("Pick a channel you're in.");
    }
    data.chatChannelId = b.chatChannelId || null;
  }
  if (b.tasksProjectId !== undefined) {
    if (b.tasksProjectId) {
      if (!can(me, "tasks.open") || !can(me, "tasks.create")) throw new HttpError(403, "Your role can't create tasks.", { key: "tasks.create" });
      await loadProject(me, String(b.tasksProjectId), { write: true });
    }
    data.tasksProjectId = b.tasksProjectId || null;
  }
  if (b.kbSuggest !== undefined) data.kbSuggest = !!b.kbSuggest;
  if (b.calendarWriteback !== undefined) data.calendarWriteback = !!b.calendarWriteback;
  if (b.emailRecap !== undefined) {
    if (!(RECAP_RULES as readonly string[]).includes(String(b.emailRecap))) bad("Email recap is off, workspace, attendees, invitees or me.");
    data.emailRecap = String(b.emailRecap);
  }
  // Turning something on from all off starts fresh: reports that were ready before aren't sent.
  const before = await settingsRow(me);
  const after = { ...before, ...data } as typeof before;
  if (!anyOn(before) && anyOn(after)) data.activeSince = new Date();
  await db.meetIntegration.upsert({ where: { ws_userId: { ws: me.ws, userId: me.userId } }, create: { ws: me.ws, userId: me.userId, ...data }, update: data });
  return getIntegrations(me);
}

const anyOn = (s: { chatChannelId: string | null; tasksProjectId: string | null; kbSuggest: boolean; calendarWriteback: boolean; emailRecap: string }) =>
  !!s.chatChannelId || !!s.tasksProjectId || s.kbSuggest || s.calendarWriteback || s.emailRecap !== "off";

// ── Webhooks ───────────────────────────────────────────────────────────────

const newSecret = () => `whsec_${crypto.randomBytes(24).toString("base64url")}`;

export async function createWebhook(me: Me, b: { url?: string }) {
  const url = str(b.url, 500);
  if (!url || !urlOk(url)) bad("The webhook URL must be a public http(s) address.");
  if ((await db.meetWebhook.count({ where: { ws: me.ws, userId: me.userId } })) >= 10) bad("You can have up to 10 webhooks.");
  const h = await db.meetWebhook.create({ data: { ws: me.ws, userId: me.userId, url, secret: newSecret() } });
  // The signing secret is shown once, here (and again after "rotate").
  return { webhook: hookDto(h), secret: h.secret };
}

async function myHook(me: Me, id: string) {
  const h = await db.meetWebhook.findFirst({ where: { id, ws: me.ws, userId: me.userId } });
  if (!h) throw new HttpError(404, "Not found");
  return h;
}

export async function updateWebhook(me: Me, id: string, b: { url?: string; active?: boolean; rotate?: boolean }) {
  const h = await myHook(me, id);
  const data: Record<string, unknown> = {};
  if (b.url !== undefined) {
    const url = str(b.url, 500);
    if (!url || !urlOk(url)) bad("The webhook URL must be a public http(s) address.");
    data.url = url;
  }
  if (b.active !== undefined) data.active = !!b.active;
  if (b.rotate) data.secret = newSecret();
  const u = await db.meetWebhook.update({ where: { id: h.id }, data });
  return { webhook: hookDto(u), ...(b.rotate ? { secret: u.secret } : {}) };
}

export async function deleteWebhook(me: Me, id: string) {
  const h = await myHook(me, id);
  await db.meetWebhook.delete({ where: { id: h.id } });
  return { ok: true };
}

async function log(d: { ws: string; userId: string; meetingId?: string | null; webhookId?: string | null; target: string; event?: string; ok: boolean; status?: number; detail?: string; ms?: number; test?: boolean }) {
  return db.meetDelivery.create({ data: { ws: d.ws, userId: d.userId, meetingId: d.meetingId ?? null, webhookId: d.webhookId ?? null, target: d.target, event: d.event ?? "report.ready", ok: d.ok, status: d.status ?? 0, detail: (d.detail ?? "").slice(0, 500), ms: d.ms ?? 0, test: !!d.test } });
}

async function deliver(h: MeetWebhook, payload: Record<string, unknown>, meetingId: string | null, test = false) {
  const t = Date.now();
  const r = await callApp(h.url, h.secret, payload, 5000);
  const ok = !!r && r.status >= 200 && r.status < 300;
  return log({ ws: h.ws, userId: h.userId, meetingId, webhookId: h.id, target: "webhook", event: String(payload.event), ok, status: r?.status ?? 0, detail: r ? `${h.url} answered ${r.status}` : `${h.url} couldn't be reached (or isn't a public address)`, ms: Date.now() - t, test });
}

/** A sample report.test delivery, from my latest report when there is one. */
export async function testWebhook(me: Me, id: string) {
  const h = await myHook(me, id);
  const m = await db.meeting.findFirst({ where: { ws: me.ws, hostId: me.userId, notesStatus: "ready" }, orderBy: { notesAt: "desc" } });
  const payload = m
    ? { ...(await reportPayload(m)), event: "report.test" }
    : { event: "report.test", id: `evt_${crypto.randomBytes(9).toString("base64url")}`, createdAt: new Date().toISOString(), workspace: me.ws, meeting: { id: "sample", code: "abc-defg-hij", title: "Sample meeting", kind: "meeting" }, report: { version: 2, summary: "This is a test delivery from IOTx Meet.", actionItems: [], decisions: [] }, notes: null, reportUrl: reportUrl("abc-defg-hij") };
  const d = await deliver(h, payload, m?.id ?? null, true);
  return { delivery: deliveryDto(d) };
}

// ── The report.ready payload ───────────────────────────────────────────────

export async function reportPayload(m: Meeting) {
  const cap = await db.meetCapture.findUnique({ where: { meetingId: m.id } });
  const host = await db.user.findUnique({ where: { id: m.hostId } });
  const joined = await db.meetParticipant.findMany({ where: { meetingId: m.id, status: "admitted" }, select: { name: true } });
  const participants = [...new Set([...(cap?.participants ?? []), ...joined.map((p) => p.name)])];
  const dur = m.durationSec ?? (m.startedAt && m.endedAt ? Math.round((m.endedAt.getTime() - m.startedAt.getTime()) / 1000) : null);
  return {
    event: "report.ready",
    id: `evt_${crypto.randomBytes(9).toString("base64url")}`,
    createdAt: new Date().toISOString(),
    workspace: m.ws,
    meeting: {
      id: m.id, code: m.code, title: m.title, kind: m.kind, platform: cap?.platform ?? "iotx", callUrl: cap?.url || null,
      startedAt: m.startedAt, endedAt: m.endedAt, durationSec: dur, eventId: m.eventId, template: m.template, language: m.reportLang || null,
      host: host ? { id: host.id, name: host.name, email: host.email } : null, participants,
    },
    report: m.report ?? null,
    notes: notesFor(m),
    reportUrl: reportUrl(m.code),
  };
}

// ── Fan-out ────────────────────────────────────────────────────────────────

const MARK_START = "── Meeting summary (IOTx Meet) ──";
const MARK_END = "── end of summary ──";

/** Add (or replace) the summary block in the calendar event's description. */
export async function writeBack(host: Me, m: Meeting, notes: MeetingNotes) {
  if (!m.eventId) return { ok: false, detail: "No calendar event is linked to this meeting." };
  const ev = await loadEvent(host, m.eventId);
  if (!canEditEvent(host, ev, ev.calendar, ev.attendees)) return { ok: false, detail: "You can't edit this calendar event." };
  if (ev.rrule) return { ok: false, detail: "Recurring series: the summary isn't written into every occurrence." };
  const block = [MARK_START, notes.summary.slice(0, 1500), ...(notes.decisions.length ? ["Decisions:", ...notes.decisions.slice(0, 8).map((d) => `• ${d}`)] : []), `Report: ${reportUrl(m.code)}`, MARK_END].join("\n");
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  const desc = re.test(ev.description) ? ev.description.replace(re, block) : [ev.description.trim(), block].filter(Boolean).join("\n\n");
  await db.event.update({ where: { id: ev.id }, data: { description: desc.slice(0, 20_000) } });
  return { ok: true, detail: `Updated "${ev.title}".` };
}

/** Recap recipients by rule (emails), host first. */
async function recapRecipients(m: Meeting, rule: string) {
  const host = await db.user.findUnique({ where: { id: m.hostId } });
  const emails = new Set<string>(host?.email ? [host.email.toLowerCase()] : []);
  if (rule === "me") return [...emails];
  const ev = m.eventId ? await db.event.findUnique({ where: { id: m.eventId }, include: { attendees: true } }) : null;
  if (rule === "invitees") {
    const us = await db.user.findMany({ where: { id: { in: m.invitees } } });
    for (const u of us) emails.add(u.email.toLowerCase());
    for (const a of ev?.attendees ?? []) if (a.email) emails.add(a.email.toLowerCase());
  } else {
    // attendees: members who joined, and for calls outside, guests of the event who didn't decline.
    const ps = await db.meetParticipant.findMany({ where: { meetingId: m.id, kind: "member", status: "admitted" } });
    const us = await db.user.findMany({ where: { id: { in: ps.map((p) => p.userId!).filter(Boolean) } } });
    for (const u of us) emails.add(u.email.toLowerCase());
    if (m.kind === "external") for (const a of ev?.attendees ?? []) if (a.email && a.response !== "no") emails.add(a.email.toLowerCase());
  }
  return [...emails].slice(0, 100);
}

type Result = { target: string; ok: boolean; detail: string };

/**
 * The report is ready: run the host's integrations once for this version.
 * Returns what happened (null when it already ran or there's no report).
 */
export async function dispatchReport(meetingId: string): Promise<Result[] | null> {
  const m = await db.meeting.findUnique({ where: { id: meetingId } });
  if (!m || m.notesStatus !== "ready") return null;
  const notes = notesFor(m);
  if (!notes) return null;
  const version = (m.notesAt ?? m.createdAt).toISOString();
  try {
    await db.meetDispatch.create({ data: { meetingId: m.id, version } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return null;
    throw e;
  }
  const out: Result[] = [];
  const note = async (target: string, ok: boolean, detail: string, status = 0, ms = 0) => {
    out.push({ target, ok, detail });
    await log({ ws: m.ws, userId: m.hostId, meetingId: m.id, target, ok, detail, status, ms });
  };
  const readyAt = m.notesAt ?? new Date();
  const hooks = await db.meetWebhook.findMany({ where: { ws: m.ws, userId: m.hostId, active: true, events: { has: "report.ready" }, createdAt: { lte: readyAt } } });
  if (hooks.length) {
    const payload = await reportPayload(m);
    for (const h of hooks) {
      const d = await deliver(h, payload, m.id);
      out.push({ target: "webhook", ok: d.ok, detail: d.detail });
    }
  }
  const s = await db.meetIntegration.findUnique({ where: { ws_userId: { ws: m.ws, userId: m.hostId } } });
  if (!s || s.activeSince > readyAt) return out;
  const host = await meFor(m.ws, m.hostId);
  if (!host) {
    if (s.chatChannelId || s.tasksProjectId || s.kbSuggest || s.calendarWriteback || s.emailRecap !== "off") await note("all", false, "The host has no Workspace session; sign in once to turn integrations on.");
    return out;
  }
  const link = reportUrl(m.code);
  const step = async (target: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const t = Date.now();
    try {
      const r = await fn();
      await note(target, r.ok, r.detail, 0, Date.now() - t);
    } catch (e) {
      await note(target, false, e instanceof HttpError ? e.message : "Something went wrong.", e instanceof HttpError ? e.status : 500, Date.now() - t);
      if (!(e instanceof HttpError)) console.error(`[meet] integration ${target}`, e);
    }
  };
  if (s.chatChannelId)
    await step("chat", async () => {
      if (!can(host, "teamchat.open")) return { ok: false, detail: "Your role can't use Team Chat." };
      const msg = await postMessage(host, s.chatChannelId!, { body: `${notesText(m, notes)}\n\nFull report: ${link}` });
      return { ok: true, detail: `Posted (message ${msg.id}).` };
    });
  if (s.tasksProjectId && notes.actionItems.length)
    await step("tasks", async () => {
      if (m.notesTaskIds.length) return { ok: true, detail: "The action items are already tasks." };
      // notesToTasks reads action items from the notes; a report-only meeting gets them copied over first.
      const withNotes = m.notes ? m : await db.meeting.update({ where: { id: m.id }, data: { notes: notes as never } });
      const r = await notesToTasks(host, withNotes, { projectId: s.tasksProjectId! });
      // For You (Read's action items) won't offer these again.
      await db.readActionTask.createMany({ data: r.taskIds.map((taskId, idx) => ({ meetingId: m.id, idx, taskId, userId: host.userId })), skipDuplicates: true }).catch(() => null);
      return { ok: true, detail: `${r.taskIds.length} task(s) created.` };
    });
  if (s.kbSuggest && notes.decisions.length)
    await step("kb", async () => {
      const when = (m.startedAt ?? m.createdAt).toISOString().slice(0, 10);
      const body = [`Decisions from the meeting "${m.title}" (${when}):`, "", ...notes.decisions.map((d) => `- ${d}`), "", `Report: ${link}`].join("\n");
      const r = await suiteCall<{ suggestion?: { id: string }; error?: string }>("/api/iotx/kb", {
        body: { userId: host.userId, ws: host.ws, suggest: { title: `Decisions: ${m.title}`.slice(0, 200), body, reason: "Suggested by Meet when the meeting's report was ready.", sourceRef: `meet:${m.code}` } },
      });
      if (r.status === 201 || r.data.suggestion) return { ok: true, detail: `Suggested to the knowledge base (${r.data.suggestion?.id ?? "queued"}).` };
      return { ok: false, detail: `The knowledge base answered ${r.status}${r.data.error ? `: ${r.data.error}` : ""}.` };
    });
  if (s.calendarWriteback && m.eventId) await step("calendar", () => writeBack(host, m, notes));
  if (s.emailRecap !== "off")
    await step("email", async () => {
      let rule = s.emailRecap;
      let to: string[];
      if (rule === "workspace") {
        // Meet's sharing setting decides (the same people helper B's recapRecipients names).
        rule = await workspaceRecap(m.ws);
        const { recapRecipients: wsRecipients } = await import("./read");
        const ids = await wsRecipients(m.id).catch(() => [m.hostId]);
        to = (await db.user.findMany({ where: { id: { in: ids } }, select: { email: true } })).map((u) => u.email.toLowerCase()).filter(Boolean);
        if (rule === "invitees" && m.kind === "external") to = [...new Set([...to, ...(await recapRecipients(m, "invitees"))])];
      } else to = await recapRecipients(m, rule);
      const { sendMail } = await import("../cal-mail");
      let sent = 0;
      for (const addr of to) if (await sendMail({ to: addr, subject: `Recap: ${m.title}`, text: `${notesText(m, notes)}\n\nFull report: ${link}`, fromName: "IOTx Meet" })) sent++;
      return { ok: sent === to.length, detail: `Recap (${rule}) emailed to ${sent} of ${to.length}.` };
    });
  return out;
}

/** Every 20 seconds: meetings whose report became ready in the last 2 hours, for hosts with integrations on. */
export async function integrationsTick(now = new Date(), o: { only?: string[] } = {}) {
  const since = new Date(now.getTime() - 2 * 3_600_000);
  const a = await db.meetIntegration.findMany({
    where: { OR: [{ chatChannelId: { not: null } }, { tasksProjectId: { not: null } }, { kbSuggest: true }, { calendarWriteback: true }, { emailRecap: { not: "off" } }] },
    select: { ws: true, userId: true },
  });
  const b = await db.meetWebhook.findMany({ where: { active: true }, select: { ws: true, userId: true }, distinct: ["ws", "userId"] });
  const hosts = [...new Map([...a, ...b].map((x) => [`${x.ws}:${x.userId}`, x])).values()];
  if (!hosts.length) return { ran: 0 };
  const ms = await db.meeting.findMany({
    where: { notesStatus: "ready", notesAt: { gte: since }, OR: hosts.map((h) => ({ ws: h.ws, hostId: h.userId })), ...(o.only ? { id: { in: o.only } } : {}) },
    select: { id: true, notesAt: true },
    take: 200,
  });
  const done = new Set((await db.meetDispatch.findMany({ where: { meetingId: { in: ms.map((m) => m.id) } }, select: { meetingId: true, version: true } })).map((d) => `${d.meetingId}:${d.version}`));
  let ran = 0;
  for (const m of ms) {
    if (done.has(`${m.id}:${m.notesAt!.toISOString()}`)) continue;
    if (await dispatchReport(m.id).catch((e) => (console.error("[meet] integrations", e), null))) ran++;
  }
  return { ran };
}
