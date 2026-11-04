import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionToken, MeetCapture } from "@prisma/client";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad, str } from "../http";
import { findConference, loadEvent, occurrences } from "../calendar";
import { limited, MEET_KEYS, newCode } from "./meetings";

/**
 * Outside meetings: Google Meet, Zoom and Teams calls on the web, captured by
 * our own browser extension (apps/read-extension) instead of a meeting bot.
 *
 * The extension signs in with an ExtensionToken: a person makes one in
 * Meet → Integrations ("Connect browser extension"). The token is shown once
 * (or traded by the extension for a one-time pairing code, valid 10 minutes)
 * and only its sha256 is kept; the person can revoke it any time. The same
 * kind of token ("api") signs MCP clients in (/api/mcp). Requests send
 * "Authorization: Bearer iotxr_…" and act as that person, with the
 * permission switches of their latest Workspace session.
 *
 * A capture is a meeting of kind "external": the extension starts it, sends
 * the call's audio (tab audio mixed with the person's mic) in 10-second
 * MediaRecorder chunks, and finishes it; the chunks are joined in order and
 * handed to the report pipeline (report.ts ingestAudio).
 */

export const CAPTURE_DIR = path.resolve(process.env.MEET_CAPTURE_DIR ?? path.join(process.cwd(), "storage", "meet-external"));
const CHUNK_MAX = 5 * 1024 * 1024;
const CAPTURE_MAX = 200 * 1024 * 1024;
const PAIR_MS = 10 * 60_000;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => `iotxr_${crypto.randomBytes(30).toString("base64url")}`;
const PAIR_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newPairCode = () => {
  const s = Array.from(crypto.randomBytes(8), (b) => PAIR_LETTERS[b % PAIR_LETTERS.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
const cleanPair = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── Tokens ─────────────────────────────────────────────────────────────────

function tokenDto(t: ExtensionToken) {
  return { id: t.id, name: t.name, kind: t.kind, hint: t.hint, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revoked: !!t.revokedAt, pairing: !!t.pairHash && !!t.pairUntil && t.pairUntil > new Date() };
}

export async function listTokens(me: Me) {
  const rows = await db.extensionToken.findMany({ where: { ws: me.ws, userId: me.userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  return rows.map(tokenDto);
}

/** A new token, shown once, plus a pairing code the extension can trade for it instead. */
export async function createToken(me: Me, b: { name?: string; kind?: string }) {
  if (!can(me, MEET_KEYS.open)) throw new HttpError(403, "Your role can't use Meet.", { key: MEET_KEYS.open });
  const kind = b.kind === "api" ? "api" : "extension";
  const name = str(b.name, 60) || (kind === "api" ? "API token" : "Browser extension");
  if ((await db.extensionToken.count({ where: { ws: me.ws, userId: me.userId, revokedAt: null } })) >= 20) bad("You can have up to 20 tokens. Revoke one you no longer use.");
  const token = newToken();
  const pairCode = kind === "extension" ? newPairCode() : null;
  const row = await db.extensionToken.create({
    data: { ws: me.ws, userId: me.userId, name, kind, tokenHash: sha(token), hint: token.slice(0, 12), pairHash: pairCode ? sha(cleanPair(pairCode)) : null, pairUntil: pairCode ? new Date(Date.now() + PAIR_MS) : null },
  });
  return { token, pairCode, pairUntil: row.pairUntil, item: tokenDto(row) };
}

export async function revokeToken(me: Me, id: string) {
  const t = await db.extensionToken.findFirst({ where: { id, ws: me.ws, userId: me.userId } });
  if (!t) throw new HttpError(404, "Not found");
  await db.extensionToken.update({ where: { id }, data: { revokedAt: new Date(), pairHash: null } });
  return { ok: true };
}

/**
 * The extension trades a pairing code for a token. The code works once; the
 * token it gets is new (the one shown on screen stops working), so a code
 * read over someone's shoulder is useless once it has been used.
 */
export async function pair(code: unknown, ip: string, name?: string) {
  if (limited(`ext-pair:${ip}`, 10, 10 * 60_000)) throw new HttpError(429, "Too many tries. Wait a few minutes.");
  const c = cleanPair(code);
  if (c.length !== 8) bad("Enter the 8-character code from Meet → Integrations.");
  const t = await db.extensionToken.findFirst({ where: { pairHash: sha(c), revokedAt: null } });
  if (!t || !t.pairUntil || t.pairUntil < new Date()) throw new HttpError(401, "That code isn't valid or has expired. Make a new one in Meet → Integrations.");
  const token = newToken();
  await db.extensionToken.update({ where: { id: t.id }, data: { tokenHash: sha(token), hint: token.slice(0, 12), pairHash: null, pairUntil: null, ...(name ? { name: str(name, 60) } : {}) } });
  const u = await db.user.findUnique({ where: { id: t.userId } });
  return { token, user: { name: u?.name ?? u?.email ?? "", email: u?.email ?? "" }, ws: t.ws };
}

/** The person behind "Authorization: Bearer iotxr_…", with their latest Workspace permissions. */
export async function tokenMe(req: Request): Promise<{ me: Me; token: ExtensionToken }> {
  const raw = /^Bearer\s+(iotxr_[\w-]{30,})\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!raw) throw new HttpError(401, "Send your token as Authorization: Bearer iotxr_… (Meet → Integrations).");
  const t = await db.extensionToken.findUnique({ where: { tokenHash: sha(raw) } });
  if (!t || t.revokedAt) throw new HttpError(401, "That token isn't valid or was revoked.");
  const s = await db.session.findFirst({ where: { userId: t.userId, ws: t.ws, guest: false }, orderBy: { permsAt: "desc" } });
  const u = await db.user.findUnique({ where: { id: t.userId } });
  const member = await db.member.findUnique({ where: { ws_userId: { ws: t.ws, userId: t.userId } } });
  if (!s || !u || !member) throw new HttpError(401, "Sign in to Workspace once, then try again.");
  if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 60_000) await db.extensionToken.update({ where: { id: t.id }, data: { lastUsedAt: new Date() } }).catch(() => null);
  const perms = s.perms as Record<string, boolean>;
  if (!perms[MEET_KEYS.open]) throw new HttpError(403, "Your role can't use Meet.", { key: MEET_KEYS.open });
  const me: Me = { sid: `token:${t.id}`, userId: t.userId, ws: t.ws, name: u.name ?? u.email, email: u.email, tz: u.tz, owner: s.owner, perms, stale: false, guest: false };
  return { me, token: t };
}

// ── Captures ───────────────────────────────────────────────────────────────

export function platformOf(url: string) {
  let h = "";
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {}
  if (h === "meet.google.com") return "meet";
  if (h === "zoom.us" || h.endsWith(".zoom.us") || h === "zoom.com" || h.endsWith(".zoom.com")) return "zoom";
  if (h === "teams.microsoft.com" || h === "teams.live.com" || h.endsWith(".teams.microsoft.com") || h === "teams.cloud.microsoft") return "teams";
  return "other";
}
const PLATFORM_NAME: Record<string, string> = { meet: "Google Meet", zoom: "Zoom", teams: "Microsoft Teams", other: "Web call" };

const cleanNames = (v: unknown) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, 80).replace(/\s+/g, " ")).filter((x) => x && !/^(you|me|\(you\))$/i.test(x)))].slice(0, 100);

/** The part of a call link that identifies the meeting (Meet code, Zoom id, Teams thread). */
function callKey(url: string) {
  try {
    const u = new URL(url);
    const p = platformOf(url);
    if (p === "meet") return /\/([a-z]{3}-[a-z]{4}-[a-z]{3})/.exec(u.pathname)?.[1] ?? null;
    if (p === "zoom") return /\/(?:j|wc(?:\/join)?|s)\/(\d{9,12})/.exec(u.pathname)?.[1] ?? /\/wc\/(\d{9,12})/.exec(u.pathname)?.[1] ?? null;
    if (p === "teams") return /19(?:%3a|:)meeting_[A-Za-z0-9]+/i.exec(url)?.[0] ?? null;
  } catch {}
  return null;
}

/** Today's calendar entry for this call link (the one closest to now), if any. */
async function eventForCall(me: Me, url: string) {
  const key = callKey(url);
  if (!key || !can(me, "calendar.open")) return null;
  const now = Date.now();
  const occ = await occurrences(me, new Date(now - 6 * 3_600_000), new Date(now + 6 * 3_600_000)).catch(() => []);
  const hits = occ.filter((o) => [o.conferenceUrl, o.location, o.description].some((t) => t && t.includes(key)));
  hits.sort((a, b) => Math.abs(new Date(a.start).getTime() - now) - Math.abs(new Date(b.start).getTime() - now));
  return hits[0] ?? null;
}

const capDir = (c: Pick<MeetCapture, "id">) => path.join(CAPTURE_DIR, c.id);

export async function startCapture(me: Me, tokenId: string | null, b: { title?: string; platform?: string; url?: string; participants?: unknown; eventId?: string; mime?: string }) {
  if (!can(me, MEET_KEYS.aiNotes)) throw new HttpError(403, "Your role can't use AI notes. Ask an admin to turn on Meet AI notes.", { key: MEET_KEYS.aiNotes });
  const url = str(b.url, 1000);
  const platform = ["meet", "zoom", "teams", "other"].includes(String(b.platform)) ? String(b.platform) : platformOf(url);
  if (limited(`ext-start:${me.userId}`, 20, 60 * 60_000)) throw new HttpError(429, "Too many recordings started in the last hour.");
  let event: { id: string; title: string } | null = null;
  if (b.eventId) {
    const ev = await loadEvent(me, String(b.eventId));
    event = { id: ev.id, title: ev.title };
  } else {
    const o = url ? await eventForCall(me, url) : null;
    if (o) event = { id: o.id, title: o.title };
  }
  const ev = event ? await db.event.findUnique({ where: { id: event.id }, include: { attendees: true } }) : null;
  const invitees = ev ? [...new Set(ev.attendees.map((a) => a.userId).filter((x): x is string => !!x && x !== me.userId))] : [];
  const title = str(b.title, 200) || event?.title || `${PLATFORM_NAME[platform]} call`;
  const mime = /^audio\/(webm|ogg|mp4)/.test(String(b.mime)) ? String(b.mime).split(";")[0] : "audio/webm";
  for (let i = 0; i < 5; i++) {
    try {
      const m = await db.meeting.create({
        data: { ws: me.ws, kind: "external", code: newCode(), title, hostId: me.userId, eventId: event?.id ?? null, invitees, allowGuests: false, startedAt: new Date(), notesStatus: "recording" },
      });
      const c = await db.meetCapture.create({ data: { meetingId: m.id, ws: me.ws, userId: me.userId, tokenId, platform, url, participants: cleanNames(b.participants), mime } });
      fs.mkdirSync(capDir(c), { recursive: true });
      return { captureId: c.id, meetingId: m.id, code: m.code, title: m.title, platform, eventId: m.eventId, reportUrl: reportUrl(m.code) };
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  throw new HttpError(500, "Couldn't start the recording. Try again.");
}

export const reportUrl = (code: string) => {
  const base = (process.env.WORKSPACE_PUBLIC_URL || process.env.APP_URL || "").replace(/\/$/, "");
  return `${base}/workspace/meet/${code}/notes`;
};

async function myCapture(me: Me, id: string) {
  const c = await db.meetCapture.findUnique({ where: { id } });
  if (!c || c.userId !== me.userId || c.ws !== me.ws) throw new HttpError(404, "Not found");
  return c;
}

/** One 10-second chunk. Re-sending a chunk (a retry) replaces it. */
export async function addChunk(me: Me, id: string, seqRaw: unknown, buf: Buffer) {
  const c = await myCapture(me, id);
  if (c.status !== "recording") throw new HttpError(409, "This recording has already finished.");
  const seq = seqRaw === null || seqRaw === undefined || seqRaw === "" ? NaN : Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 0 || seq > 100_000) bad("seq must be the chunk number (0, 1, 2…).");
  if (!buf.length) bad("The chunk is empty.");
  if (buf.length > CHUNK_MAX) throw new HttpError(413, "A chunk can be at most 5 MB.");
  if (c.bytes + buf.length > CAPTURE_MAX) throw new HttpError(413, "This recording is too long (200 MB). Stop and start a new one.");
  const dir = capDir(c);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(seq).padStart(6, "0")}.part`);
  const had = fs.existsSync(file) ? fs.statSync(file).size : 0;
  fs.writeFileSync(file, buf);
  const u = await db.meetCapture.update({ where: { id: c.id }, data: { chunks: { increment: had ? 0 : 1 }, bytes: { increment: buf.length - had } } });
  return { ok: true, seq, chunks: u.chunks, bytes: u.bytes };
}

/** Title or names seen on the call page since the start. */
export async function updateCapture(me: Me, id: string, b: { title?: string; participants?: unknown }) {
  const c = await myCapture(me, id);
  const names = cleanNames(b.participants);
  if (names.length) await db.meetCapture.update({ where: { id: c.id }, data: { participants: [...new Set([...c.participants, ...names])].slice(0, 100) } });
  const title = str(b.title, 200);
  if (title) await db.meeting.update({ where: { id: c.meetingId }, data: { title } });
  return captureStatus(me, id);
}

export async function captureStatus(me: Me, id: string) {
  const c = await myCapture(me, id);
  const m = await db.meeting.findUniqueOrThrow({ where: { id: c.meetingId } });
  return { captureId: c.id, status: c.status, error: c.error, chunks: c.chunks, bytes: c.bytes, platform: c.platform, participants: c.participants, meetingId: m.id, code: m.code, title: m.title, notesStatus: m.notesStatus, notesError: m.notesError, reportUrl: reportUrl(m.code) };
}

/** Join the chunks in order into one file. */
function joinChunks(c: MeetCapture) {
  const dir = capDir(c);
  const parts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".part")).sort() : [];
  if (!parts.length) return null;
  const ext = c.mime === "audio/ogg" ? "ogg" : c.mime === "audio/mp4" ? "m4a" : "webm";
  const out = path.join(dir, `call.${ext}`);
  fs.writeFileSync(out, Buffer.concat(parts.map((p) => fs.readFileSync(path.join(dir, p)))));
  const missing = parts.length - 1 !== Number(parts[parts.length - 1].slice(0, 6));
  return { file: out, missing };
}

/**
 * Stop: join the chunks and make the report in the background (report.ts
 * ingestAudio). When it's ready, the "report ready" integrations run.
 */
export async function finishCapture(me: Me, id: string, b: { title?: string; participants?: unknown } = {}) {
  await updateCapture(me, id, b);
  const c = await myCapture(me, id);
  if (c.status !== "recording") return captureStatus(me, id);
  const joined = joinChunks(c);
  const now = new Date();
  if (!joined) {
    await db.meetCapture.update({ where: { id: c.id }, data: { status: "failed", error: "Nothing was recorded.", endedAt: now } });
    await db.meeting.update({ where: { id: c.meetingId }, data: { endedAt: now, notesStatus: "failed", notesError: "Nothing was recorded." } });
    return captureStatus(me, id);
  }
  await db.meetCapture.update({ where: { id: c.id }, data: { status: "finishing", endedAt: now } });
  await db.meeting.update({ where: { id: c.meetingId }, data: { endedAt: now, notesStatus: "processing", notesError: "" } });
  void processCapture(c.id, joined.file);
  return captureStatus(me, id);
}

async function processCapture(captureId: string, file: string) {
  const c = await db.meetCapture.findUniqueOrThrow({ where: { id: captureId } });
  try {
    const { ingestAudio } = await import("./report");
    await ingestAudio(c.meetingId, file, { mime: c.mime, speakers: c.participants });
    const m = await db.meeting.findUniqueOrThrow({ where: { id: c.meetingId } });
    const ok = m.notesStatus === "ready";
    await db.meetCapture.update({ where: { id: c.id }, data: { status: ok ? "done" : "failed", error: ok ? "" : m.notesError || "The report couldn't be made." } });
    if (ok) {
      // ingestAudio kept a copy as the meeting's playable recording; the chunks and the joined file go.
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      const { dispatchReport } = await import("./integrations");
      await dispatchReport(c.meetingId).catch((e) => console.error("[meet] integrations", e));
    }
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "Something went wrong while making the report.";
    if (!(e instanceof HttpError)) console.error("[meet] external report", e);
    await db.meetCapture.update({ where: { id: c.id }, data: { status: "failed", error: msg } }).catch(() => null);
    await db.meeting.update({ where: { id: c.meetingId }, data: { notesStatus: "failed", notesError: msg } }).catch(() => null);
  }
}

/** Throw a recording away (while recording or after a failure): its meeting and audio go too. */
export async function discardCapture(me: Me, id: string) {
  const c = await myCapture(me, id);
  if (c.status === "finishing") throw new HttpError(409, "The report is being made. Delete the meeting afterwards if you don't want it.");
  fs.rmSync(capDir(c), { recursive: true, force: true });
  await db.meetCapture.delete({ where: { id: c.id } });
  if (c.status !== "done") await db.meeting.delete({ where: { id: c.meetingId } }).catch(() => null);
  return { ok: true };
}

/** For the extension's popup: today's meetings from Calendar that have a call link. */
export async function upcomingCalls(me: Me) {
  if (!can(me, "calendar.open")) return [];
  const now = Date.now();
  const occ = await occurrences(me, new Date(now - 2 * 3_600_000), new Date(now + 24 * 3_600_000)).catch(() => []);
  return occ
    .filter((o) => !o.allDay && new Date(o.end).getTime() > now)
    .map((o) => {
      const url = o.conferenceUrl || findConference(o.location, o.description);
      return url ? { id: o.id, title: o.title, start: o.start, end: o.end, url, platform: /\/workspace\/meet\//.test(url) ? "iotx" : platformOf(url) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 20);
}
