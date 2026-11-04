import crypto from "node:crypto";
import { Prisma, type Meeting } from "@prisma/client";
import { db } from "../db";
import { HttpError, type Me } from "../auth";
import { bad, str } from "../http";
import { canSeeNotes, type MeetingNotes } from "./notes";

/**
 * Read AI parity, across meetings (helper B): who may see a report
 * (canSeeReport), the reports a person can see, folders (personal, shared,
 * smart), report shares, the workspace's recap setting and participant
 * opt-outs. The report itself (Meeting.report v2) is written by helper A;
 * see docs/readai-contract.md.
 */

export type Report = {
  version: 2;
  template: string;
  language: string;
  summary: string;
  chapters: { title: string; start: number; end: number; summary: string }[];
  actionItems: { title: string; owner: string; due: string; start: number | null }[];
  keyQuestions: { question: string; askedBy: string; answered: boolean; start: number | null }[];
  decisions: string[];
  topics: string[];
  highlights: { start: number; end: number; text: string; by: string }[];
  sections: { title: string; body: string }[];
  scores: { read: number; sentiment: number; engagement: number };
  timeline: { start: number; sentiment: number; engagement: number }[];
};

type Who = { userId: string; ws: string };

/** The v2 report, or one made from the older AI notes (no topics, scores or timestamps), or null. */
export function reportOf(m: Pick<Meeting, "report" | "notes" | "notesStatus" | "template">): Report | null {
  const r = m.report as Partial<Report> | null;
  if (r && r.version === 2) {
    return {
      version: 2, template: r.template ?? m.template ?? "general", language: r.language ?? "", summary: r.summary ?? "",
      chapters: r.chapters ?? [], actionItems: r.actionItems ?? [], keyQuestions: r.keyQuestions ?? [], decisions: r.decisions ?? [],
      topics: r.topics ?? [], highlights: r.highlights ?? [], sections: r.sections ?? [],
      scores: r.scores ?? { read: 0, sentiment: 0, engagement: 0 }, timeline: r.timeline ?? [],
    };
  }
  if (m.notesStatus === "ready" && m.notes) {
    const n = m.notes as unknown as MeetingNotes;
    return {
      version: 2, template: "general", language: "", summary: n.summary ?? "", chapters: [],
      actionItems: (n.actionItems ?? []).map((a) => ({ ...a, start: null })), keyQuestions: [], decisions: n.decisions ?? [],
      topics: [], highlights: [], sections: [], scores: { read: 0, sentiment: 0, engagement: 0 }, timeline: [],
    };
  }
  return null;
}
/** A v2 report with real scores (older notes have none). */
export const scored = (r: Report | null) => !!r && (r.scores.read > 0 || r.scores.engagement > 0 || r.scores.sentiment > 0);

/** When a meeting happened: its start, else when it was made. */
export const whenOf = (m: Pick<Meeting, "startedAt" | "createdAt">) => m.startedAt ?? m.createdAt;

/** A link to the report, at a moment in seconds when given (the report page reads ?t=). */
export const reportHref = (code: string, t?: number | null) => `/workspace/meet/${code}/notes${t != null && t >= 0 ? `?t=${Math.floor(t)}` : ""}`;

/** Admins see workspace-wide numbers (Meeting Policy) and change the recap setting: the owner, or Chat admins. */
export const isReadAdmin = (me: Me) => me.owner || !!me.perms["teamchat.admin"];

// ── Access ────────────────────────────────────────────────────────────────

async function folderIdsFor(who: Who) {
  const fs = await db.meetFolder.findMany({ where: { ws: who.ws, OR: [{ ownerId: who.userId }, { members: { has: who.userId } }] }, select: { id: true } });
  return fs.map((f) => f.id);
}

/**
 * Who may see a meeting's report: everyone who may see its notes (host,
 * invitees, members who joined), people invited to its calendar event, people
 * it was shared with, and members of a folder it is in.
 */
export async function canSeeReport(me: Me | null, m: Meeting) {
  if (!me || me.ws !== m.ws || me.guest) return false;
  if (await canSeeNotes(me, m)) return true;
  if (m.eventId && (await db.attendee.findFirst({ where: { eventId: m.eventId, userId: me.userId } }))) return true;
  if (await db.meetReportShare.findUnique({ where: { meetingId_userId: { meetingId: m.id, userId: me.userId } } })) return true;
  const fids = await folderIdsFor(me);
  return fids.length > 0 && !!(await db.meetFolderItem.findFirst({ where: { meetingId: m.id, folderId: { in: fids } } }));
}

export type Period = { from?: Date; to?: Date };
const inPeriod = (p: Period): Prisma.MeetingWhereInput[] =>
  p.from || p.to
    ? [{ OR: [{ startedAt: { gte: p.from, lt: p.to } }, { startedAt: null, createdAt: { gte: p.from, lt: p.to } }] }]
    : [];

/** Ids of every meeting this person may see the report of (canSeeReport, in bulk), optionally in a period or a folder. */
export async function visibleMeetingIds(who: Who, o: Period & { folderId?: string; direct?: boolean } = {}): Promise<string[]> {
  const evIds = (await db.attendee.findMany({ where: { userId: who.userId, event: { ws: who.ws } }, select: { eventId: true } })).map((a) => a.eventId);
  const shared = (await db.meetReportShare.findMany({ where: { userId: who.userId }, select: { meetingId: true } })).map((s) => s.meetingId);
  const fids = o.direct ? [] : await folderIdsFor(who);
  const inFolders = fids.length ? (await db.meetFolderItem.findMany({ where: { folderId: { in: fids } }, select: { meetingId: true } })).map((i) => i.meetingId) : [];
  const where: Prisma.MeetingWhereInput = {
    ws: who.ws,
    AND: [
      {
        OR: [
          { hostId: who.userId },
          { invitees: { has: who.userId } },
          { participants: { some: { userId: who.userId, status: "admitted" } } },
          ...(evIds.length ? [{ eventId: { in: evIds } }] : []),
          ...(shared.length || inFolders.length ? [{ id: { in: [...new Set([...shared, ...inFolders])] } }] : []),
        ],
      },
      ...inPeriod(o),
    ],
  };
  let ids = (await db.meeting.findMany({ where, select: { id: true } })).map((m) => m.id);
  if (o.folderId) {
    const items = new Set((await db.meetFolderItem.findMany({ where: { folderId: o.folderId }, select: { meetingId: true } })).map((i) => i.meetingId));
    ids = ids.filter((id) => items.has(id));
  }
  return ids;
}

/** The meetings with a report this person may see, newest first, each with its report. */
export async function visibleReports(who: Who, o: Period & { folderId?: string; take?: number } = {}) {
  const ids = await visibleMeetingIds(who, o);
  if (!ids.length) return [];
  const ms = await db.meeting.findMany({
    where: { id: { in: ids }, OR: [{ NOT: { report: { equals: Prisma.DbNull } } }, { notesStatus: "ready" }] },
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
    take: o.take ?? 500,
  });
  return ms.map((m) => ({ m, r: reportOf(m) })).filter((x): x is { m: Meeting; r: Report } => !!x.r);
}

export async function meetingByCode(me: Me, code: string) {
  const m = await db.meeting.findUnique({ where: { code: String(code ?? "").toLowerCase() } });
  if (!m || !(await canSeeReport(me, m))) throw new HttpError(404, "Not found");
  return m;
}

// ── Shares ────────────────────────────────────────────────────────────────

/** Share a report with people in the workspace. Anyone who may see it directly (not only through a folder) can share it. */
export async function shareReport(me: Me, code: string, userIds: string[]) {
  const m = await meetingByCode(me, code);
  if (!(await canSeeNotes(me, m)) && m.hostId !== me.userId) throw new HttpError(403, "Only people in the meeting can share its report.");
  const members = new Set((await db.member.findMany({ where: { ws: me.ws, userId: { in: userIds.slice(0, 50) } } })).map((x) => x.userId));
  const added: string[] = [];
  for (const uid of members) {
    if (uid === me.userId) continue;
    const r = await db.meetReportShare.upsert({ where: { meetingId_userId: { meetingId: m.id, userId: uid } }, create: { meetingId: m.id, userId: uid, sharedBy: me.userId }, update: {} });
    if (r.sharedBy === me.userId) added.push(uid);
  }
  const { notify } = await import("../notify");
  for (const uid of added) await notify({ ws: me.ws, userId: uid, kind: "meet.share", title: `${me.name} shared a meeting report: ${m.title}`, link: `/meet/${m.code}/notes`, key: `meet-share:${m.id}:${uid}` });
  return { shared: added.length };
}

export async function unshareReport(me: Me, code: string, userId: string) {
  const m = await meetingByCode(me, code);
  const s = await db.meetReportShare.findUnique({ where: { meetingId_userId: { meetingId: m.id, userId } } });
  if (!s) return { ok: true };
  if (s.sharedBy !== me.userId && m.hostId !== me.userId) throw new HttpError(403, "Only the person who shared it or the host can stop sharing.");
  await db.meetReportShare.delete({ where: { meetingId_userId: { meetingId: m.id, userId } } });
  return { ok: true };
}

// ── Folders ───────────────────────────────────────────────────────────────

export type SmartRules = { titleContains?: string; attendee?: string; template?: string; topic?: string; source?: string };
export const SOURCES = ["meeting", "webinar", "upload", "inperson", "external"];

function cleanRules(v: unknown): SmartRules {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const r: SmartRules = {};
  for (const k of ["titleContains", "attendee", "template", "topic"] as const) {
    const s = str(o[k], 120);
    if (s) r[k] = s;
  }
  const src = str(o.source, 20);
  if (src && SOURCES.includes(src)) r.source = src;
  return r;
}

async function loadFolder(me: Me, id: string, write = false) {
  const f = await db.meetFolder.findUnique({ where: { id } });
  if (!f || f.ws !== me.ws) throw new HttpError(404, "Folder not found");
  const isOwner = f.ownerId === me.userId;
  if (!isOwner && !f.members.includes(me.userId)) throw new HttpError(404, "Folder not found");
  if (write && !isOwner) throw new HttpError(403, "Only the folder's owner can change it.");
  return f;
}

export async function listFolders(me: Me) {
  const fs = await db.meetFolder.findMany({ where: { ws: me.ws, OR: [{ ownerId: me.userId }, { members: { has: me.userId } }] }, orderBy: { name: "asc" }, include: { _count: { select: { items: true } } } });
  return fs.map((f) => ({ id: f.id, name: f.name, kind: f.kind, members: f.members, rules: f.rules, mine: f.ownerId === me.userId, ownerId: f.ownerId, count: f._count.items }));
}

export async function createFolder(me: Me, b: { name?: string; kind?: string; members?: string[]; rules?: unknown }) {
  const name = str(b.name, 80);
  if (!name) bad("Give the folder a name.");
  const kind = b.kind === "shared" || b.kind === "smart" ? b.kind : "personal";
  const rules = kind === "smart" ? cleanRules(b.rules) : null;
  if (kind === "smart" && !Object.keys(rules!).length) bad("A smart folder needs at least one rule.");
  const members = await cleanMembers(me, b.members);
  const f = await db.meetFolder.create({ data: { ws: me.ws, ownerId: me.userId, name, kind, members: kind === "personal" ? [] : members, rules: rules ?? undefined } });
  if (kind === "smart") await fillSmart(f.id);
  return f;
}

async function cleanMembers(me: Me, ids: unknown) {
  const want = (Array.isArray(ids) ? ids : []).map(String).filter((x) => x && x !== me.userId).slice(0, 100);
  if (!want.length) return [];
  return (await db.member.findMany({ where: { ws: me.ws, userId: { in: want } } })).map((m) => m.userId);
}

/** Rename, change rules, share (personal → shared keeps the reports), or change members. */
export async function updateFolder(me: Me, id: string, b: { name?: string; kind?: string; members?: string[]; rules?: unknown }) {
  const f = await loadFolder(me, id, true);
  const data: Prisma.MeetFolderUpdateInput = {};
  if (b.name !== undefined) data.name = str(b.name, 80) || f.name;
  if (b.kind === "shared" && f.kind === "personal") data.kind = "shared";
  if (b.kind === "personal" && f.kind === "shared") data.kind = "personal";
  if (b.members !== undefined) data.members = await cleanMembers(me, b.members);
  if ((data.kind ?? f.kind) === "personal") data.members = [];
  if (b.rules !== undefined && f.kind === "smart") {
    const r = cleanRules(b.rules);
    if (!Object.keys(r).length) bad("A smart folder needs at least one rule.");
    data.rules = r;
  }
  const u = await db.meetFolder.update({ where: { id }, data });
  const added = u.members.filter((x) => !f.members.includes(x));
  if (added.length) {
    const { notify } = await import("../notify");
    for (const uid of added) await notify({ ws: me.ws, userId: uid, kind: "meet.folder", title: `${me.name} shared the folder "${u.name}" with you`, link: `/meet/folders?f=${u.id}`, key: `meet-folder:${u.id}:${uid}` });
  }
  if (u.kind === "smart") await fillSmart(u.id);
  return u;
}

export async function deleteFolder(me: Me, id: string) {
  await loadFolder(me, id, true);
  await db.meetFolder.delete({ where: { id } });
  return { ok: true };
}

/** Add reports to a folder: owners and members of a shared folder may, and only reports they can see. */
export async function addToFolder(me: Me, id: string, codes: string[]) {
  const f = await loadFolder(me, id);
  if (f.kind === "smart") bad("Smart folders fill themselves from their rules.");
  let added = 0;
  for (const code of codes.slice(0, 50)) {
    const m = await meetingByCode(me, code);
    await db.meetFolderItem.upsert({ where: { folderId_meetingId: { folderId: f.id, meetingId: m.id } }, create: { folderId: f.id, meetingId: m.id, addedBy: me.userId }, update: {} });
    added++;
  }
  return { added };
}

export async function removeFromFolder(me: Me, id: string, code: string) {
  const f = await loadFolder(me, id);
  if (f.kind === "smart") bad("Change the rules to take reports out of a smart folder.");
  const m = await db.meeting.findUnique({ where: { code } });
  if (!m) return { ok: true };
  const it = await db.meetFolderItem.findUnique({ where: { folderId_meetingId: { folderId: f.id, meetingId: m.id } } });
  if (it && it.addedBy !== me.userId && f.ownerId !== me.userId) throw new HttpError(403, "Only the owner or whoever added it can take it out.");
  await db.meetFolderItem.deleteMany({ where: { folderId: f.id, meetingId: m.id } });
  return { ok: true };
}

/** Do a meeting and its report match a smart folder's rules? */
export function matchesRules(rules: SmartRules, m: Meeting, r: Report, people: string[]) {
  const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
  if (rules.titleContains && !has(m.title, rules.titleContains)) return false;
  if (rules.template && (r.template || m.template) !== rules.template && m.template !== rules.template) return false;
  if (rules.source && m.kind !== rules.source) return false;
  if (rules.topic && !r.topics.some((t) => has(t, rules.topic!)) && !r.chapters.some((c) => has(c.title, rules.topic!))) return false;
  if (rules.attendee && !people.some((p) => has(p, rules.attendee!))) return false;
  return true;
}

/** Everyone a meeting had: participants, invitees and speakers (names and emails), for the attendee rule. */
async function peopleOf(m: Meeting) {
  const [ps, sp] = await Promise.all([
    db.meetParticipant.findMany({ where: { meetingId: m.id }, select: { name: true, userId: true } }),
    db.meetSpeaker.findMany({ where: { meetingId: m.id }, select: { name: true, userId: true } }),
  ]);
  const ids = [...new Set([...m.invitees, m.hostId, ...ps.map((p) => p.userId), ...sp.map((s) => s.userId)].filter((x): x is string => !!x))];
  const us = await db.user.findMany({ where: { id: { in: ids } }, select: { name: true, email: true } });
  return [...ps.map((p) => p.name), ...sp.map((s) => s.name), ...us.flatMap((u) => [u.name ?? "", u.email])].filter(Boolean);
}

/** Refill a smart folder from the reports its owner can see (auto items that stop matching come out). */
export async function fillSmart(folderId: string) {
  const f = await db.meetFolder.findUnique({ where: { id: folderId } });
  if (!f || f.kind !== "smart") return 0;
  const rules = cleanRules(f.rules);
  // Only what the owner sees directly, so folders never widen each other.
  const ids = await visibleMeetingIds({ userId: f.ownerId, ws: f.ws }, { direct: true });
  const ms = ids.length ? await db.meeting.findMany({ where: { id: { in: ids } } }) : [];
  const want = new Set<string>();
  for (const m of ms) {
    const r = reportOf(m);
    if (!r) continue;
    if (matchesRules(rules, m, r, rules.attendee ? await peopleOf(m) : [])) want.add(m.id);
  }
  const have = await db.meetFolderItem.findMany({ where: { folderId } });
  const drop = have.filter((h) => h.auto && !want.has(h.meetingId)).map((h) => h.meetingId);
  if (drop.length) await db.meetFolderItem.deleteMany({ where: { folderId, meetingId: { in: drop } } });
  const haveIds = new Set(have.map((h) => h.meetingId));
  const add = [...want].filter((id) => !haveIds.has(id));
  if (add.length) await db.meetFolderItem.createMany({ data: add.map((meetingId) => ({ folderId, meetingId, addedBy: f.ownerId, auto: true })), skipDuplicates: true });
  return want.size;
}

/** Refill every smart folder that could hold this meeting (call when a report is made). */
export async function refreshSmartFolders(ws: string) {
  const fs = await db.meetFolder.findMany({ where: { ws, kind: "smart" }, select: { id: true } });
  for (const f of fs) await fillSmart(f.id).catch(() => 0);
}

export async function folderReports(me: Me, id: string) {
  const f = await loadFolder(me, id);
  if (f.kind === "smart" && f.ownerId === me.userId) await fillSmart(f.id);
  const items = await db.meetFolderItem.findMany({ where: { folderId: f.id }, orderBy: { addedAt: "desc" } });
  const ms = await db.meeting.findMany({ where: { id: { in: items.map((i) => i.meetingId) } }, orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }] });
  return {
    folder: { id: f.id, name: f.name, kind: f.kind, members: f.members, rules: f.rules, mine: f.ownerId === me.userId },
    reports: ms.map((m) => reportRow(m, reportOf(m))),
  };
}

export function reportRow(m: Meeting, r: Report | null) {
  return {
    code: m.code, title: m.title, at: whenOf(m).toISOString(), kind: m.kind, template: m.template,
    summary: r?.summary.split(/(?<=[.!?])\s/)[0]?.slice(0, 240) ?? "", topics: r?.topics.slice(0, 5) ?? [],
    score: scored(r) ? r!.scores.read : null, href: reportHref(m.code),
  };
}

// ── Recap setting (who gets recaps automatically) ─────────────────────────

export type RecapTo = "attendees" | "invitees" | "me";
export async function readSettings(ws: string) {
  const s = await db.meetReadSettings.findUnique({ where: { ws } });
  return { recapTo: (s?.recapTo ?? "attendees") as RecapTo };
}
export async function saveReadSettings(me: Me, b: { recapTo?: string }) {
  if (!isReadAdmin(me)) throw new HttpError(403, "Only workspace admins can change who gets recaps.");
  const recapTo = b.recapTo === "invitees" || b.recapTo === "me" ? b.recapTo : "attendees";
  await db.meetReadSettings.upsert({ where: { ws: me.ws }, create: { ws: me.ws, recapTo, updatedBy: me.userId }, update: { recapTo, updatedBy: me.userId } });
  return { recapTo };
}

/**
 * Who gets a meeting's recap automatically, by the workspace setting (for
 * whoever sends recaps): attendees = the host and members who joined;
 * invitees = those plus Meet invitees and the calendar event's guests;
 * me = only the host. Suite user ids.
 */
export async function recapRecipients(meetingId: string): Promise<string[]> {
  const m = await db.meeting.findUnique({ where: { id: meetingId } });
  if (!m) return [];
  const { recapTo } = await readSettings(m.ws);
  const out = new Set<string>([m.hostId]);
  if (recapTo === "me") return [...out];
  for (const p of await db.meetParticipant.findMany({ where: { meetingId, kind: "member", status: "admitted" } })) if (p.userId) out.add(p.userId);
  if (recapTo === "invitees") {
    for (const u of m.invitees) out.add(u);
    if (m.eventId) for (const a of await db.attendee.findMany({ where: { eventId: m.eventId, userId: { not: null } } })) out.add(a.userId!);
  }
  return [...out];
}

// ── Opt-out (don't summarise me) ──────────────────────────────────────────

const hash = (t: string) => crypto.createHash("sha256").update(`read-optout:${t}`).digest("hex");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A member opts out (or back in) while signed in. */
export async function setMyOptOut(me: Me, on: boolean) {
  const email = me.email.toLowerCase();
  if (on) await db.readOptOut.upsert({ where: { ws_email: { ws: me.ws, email } }, create: { ws: me.ws, email, name: me.name, userId: me.userId, confirmedAt: new Date() }, update: { userId: me.userId, name: me.name, confirmedAt: new Date(), tokenHash: null } });
  else await db.readOptOut.deleteMany({ where: { ws: me.ws, email } });
  return { optedOut: on };
}
export async function myOptOut(me: Me) {
  const r = await db.readOptOut.findUnique({ where: { ws_email: { ws: me.ws, email: me.email.toLowerCase() } } });
  return !!r?.confirmedAt;
}

/**
 * Someone outside asks not to be summarised in a workspace's meetings (from
 * a meeting link's code). They confirm with an emailed link; the reply never
 * says whether the address is known.
 */
export async function requestOptOut(b: { code?: string; email?: string; name?: string }, origin: string) {
  const email = str(b.email, 200).toLowerCase();
  if (!EMAIL.test(email)) bad("Enter your email address.");
  const m = await db.meeting.findUnique({ where: { code: str(b.code, 20).toLowerCase() } });
  if (!m) bad("Enter the meeting link or code you were invited with.");
  const token = crypto.randomBytes(24).toString("base64url");
  const name = str(b.name, 120);
  const row = await db.readOptOut.findUnique({ where: { ws_email: { ws: m.ws, email } } });
  if (row?.confirmedAt) return { ok: true };
  await db.readOptOut.upsert({ where: { ws_email: { ws: m.ws, email } }, create: { ws: m.ws, email, name, tokenHash: hash(token) }, update: { name: name || row?.name || "", tokenHash: hash(token) } });
  const { sendMail } = await import("../cal-mail");
  const link = `${origin}/workspace/meet/opt-out?t=${token}`;
  await sendMail({
    to: email,
    subject: "Confirm: don't summarise me in meetings",
    text: `Someone (hopefully you) asked that meetings in this workspace don't include you in AI transcripts and reports.\n\nConfirm: ${link}\n\nIf this wasn't you, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px;max-width:520px"><p>Someone (hopefully you) asked that meetings in this workspace don't include you in AI transcripts and reports.</p><p><a href="${link}" style="display:inline-block;padding:8px 16px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none">Confirm opt-out</a></p><p style="color:#6a6e8a;font-size:12px">If this wasn't you, ignore this email.</p></div>`,
  });
  return { ok: true };
}
export async function confirmOptOut(token: string) {
  const t = str(token, 100);
  if (t.length < 20) bad("This link isn't valid.");
  const row = await db.readOptOut.findFirst({ where: { tokenHash: hash(t) } });
  if (!row) bad("This link isn't valid or was already used.");
  await db.readOptOut.update({ where: { id: row.id }, data: { confirmedAt: new Date(), tokenHash: null } });
  return { ok: true, email: row.email };
}

/** Confirmed opt-outs for a workspace. */
export async function optOuts(ws: string) {
  return db.readOptOut.findMany({ where: { ws, confirmedAt: { not: null } } });
}

/**
 * Drop the lines of people who opted out from a meeting's transcript, before
 * a report is built (and again afterwards, for anything already written):
 * their MeetSegment, MeetCaption and MeetSpeaker rows, their lines in the old
 * transcript text, and the report items attributed to them. Matched by user
 * id, LiveKit identity, registered email, or name. Returns the names dropped.
 */
export async function applyOptOuts(meetingId: string): Promise<string[]> {
  const m = await db.meeting.findUnique({ where: { id: meetingId } });
  if (!m) return [];
  const outs = await optOuts(m.ws);
  if (!outs.length) return [];
  const ps = await db.meetParticipant.findMany({ where: { meetingId } });
  const regs = await db.meetRegistrant.findMany({ where: { meetingId }, select: { email: true, identity: true } });
  const users = await db.user.findMany({ where: { email: { in: outs.map((o) => o.email), mode: "insensitive" } }, select: { id: true, email: true, name: true } });
  const userIds = new Set([...outs.map((o) => o.userId), ...users.map((u) => u.id)].filter((x): x is string => !!x));
  const emails = new Set(outs.map((o) => o.email.toLowerCase()));
  const identities = new Set<string>([...userIds].map((u) => `u_${u}`));
  for (const r of regs) if (r.identity && emails.has(r.email.toLowerCase())) identities.add(r.identity);
  const names = new Set<string>();
  for (const p of ps) if ((p.userId && userIds.has(p.userId)) || identities.has(p.identity)) { names.add(p.name.toLowerCase()); identities.add(p.identity); }
  // Outside people who joined under the name they gave when opting out.
  for (const o of outs) if (o.name && ps.some((p) => p.kind === "guest" && p.name.toLowerCase() === o.name.toLowerCase())) names.add(o.name.toLowerCase());
  for (const u of users) if (u.name && ps.some((p) => p.userId === u.id)) names.add(u.name.toLowerCase());
  if (!names.size && !identities.size) return [];
  const idList = [...identities, ...userIds];
  const nameList = [...names];
  await db.meetSegment.deleteMany({ where: { meetingId, OR: [{ identity: { in: idList } }, ...nameList.map((n) => ({ speaker: { equals: n, mode: "insensitive" as const } }))] } });
  await db.meetCaption.deleteMany({ where: { meetingId, OR: [{ identity: { in: idList } }, ...nameList.map((n) => ({ name: { equals: n, mode: "insensitive" as const } }))] } });
  await db.meetSpeaker.deleteMany({ where: { meetingId, OR: [{ userId: { in: [...userIds] } }, ...nameList.map((n) => ({ name: { equals: n, mode: "insensitive" as const } }))] } });
  const isOut = (who: string) => names.has(who.trim().toLowerCase());
  const data: Prisma.MeetingUpdateInput = {};
  if (m.transcript) {
    const kept = m.transcript.split("\n").filter((l) => { const w = /^\s*(?:\[[^\]]*\]\s*)?([^:]{1,80}):/.exec(l)?.[1]; return !(w && isOut(w)); });
    if (kept.length !== m.transcript.split("\n").length) data.transcript = kept.join("\n");
  }
  const r = m.report as Partial<Report> | null;
  if (r?.version === 2) {
    data.report = {
      ...r,
      highlights: (r.highlights ?? []).filter((h) => !isOut(h.by)),
      keyQuestions: (r.keyQuestions ?? []).filter((q) => !isOut(q.askedBy)),
    } as Prisma.InputJsonValue;
  }
  if (Object.keys(data).length) await db.meeting.update({ where: { id: meetingId }, data });
  return nameList;
}

// ── Attendance per day (recurring series reuse one meeting) ───────────────

/** Note that someone was in a meeting today (UTC day). Never fails the caller. */
export async function logAttendance(meetingId: string, userId: string, at = new Date()) {
  const day = at.toISOString().slice(0, 10);
  await db.readAttendance.upsert({ where: { meetingId_userId_day: { meetingId, userId, day } }, create: { meetingId, userId, day, at }, update: {} }).catch(() => null);
}

// ── Prefs (Daily Read) ────────────────────────────────────────────────────

export async function readPrefs(me: Who) {
  const p = await db.readPrefs.findUnique({ where: { ws_userId: { ws: me.ws, userId: me.userId } } });
  return { dailyRead: !!p?.dailyRead, dailyHour: p?.dailyHour ?? 7 };
}
export async function saveReadPrefs(me: Me, b: { dailyRead?: boolean; dailyHour?: number }) {
  const cur = await readPrefs(me);
  const dailyRead = b.dailyRead === undefined ? cur.dailyRead : !!b.dailyRead;
  const h = Number(b.dailyHour);
  const dailyHour = Number.isInteger(h) && h >= 4 && h <= 11 ? h : cur.dailyHour;
  await db.readPrefs.upsert({ where: { ws_userId: { ws: me.ws, userId: me.userId } }, create: { ws: me.ws, userId: me.userId, dailyRead, dailyHour }, update: { dailyRead, dailyHour } });
  return { dailyRead, dailyHour };
}
