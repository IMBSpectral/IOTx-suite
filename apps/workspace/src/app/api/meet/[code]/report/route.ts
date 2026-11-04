import path from "node:path";
import { db } from "@/lib/db";
import { getMe, HttpError } from "@/lib/auth";
import { bad, body, route } from "@/lib/http";
import { byCode, hostLikeIdentity, isMember } from "@/lib/meet/meetings";
import { recordingPath, requireRecorder } from "@/lib/meet/recording";
import { buildReport, canSeeMeetingReport, ingestAudio, isBuilding, renameSpeaker, reportDto, resolveTemplate, translateReport } from "@/lib/meet/report";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/**
 * GET ?lang=  -> the Read-style report with speakers, transcript segments and
 *               the media to play (host, invitees, members who joined).
 * POST { action: "regenerate", template?, lang? }   re-make (hosts with AI notes)
 *      { action: "template", template }             pick the template; re-makes a finished report
 *      { action: "translate", lang }                the report in another language (anyone who can read it)
 *      { action: "rename", from, to }               rename a speaker (hosts)
 *      { action: "share", emails: string[] }        let workspace members read it (hosts)
 */
async function GET_(req: Request, ctx: Ctx) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  if (!(await canSeeMeetingReport(me, m))) throw new HttpError(404, "Not found");
  const lang = new URL(req.url).searchParams.get("lang");
  const host = isMember(me, m) && hostLikeIdentity(m, `u_${me.userId}`);
  return Response.json({
    title: m.title,
    code: m.code,
    host,
    status: m.notesStatus,
    error: m.notesError,
    at: m.notesAt,
    startedAt: m.startedAt ?? m.createdAt,
    taskIds: m.notesTaskIds,
    postedAt: m.notesPostedAt,
    sentAt: m.notesSentAt,
    channelId: m.channelId,
    ...(await reportDto(m, lang)),
  });
}

async function remake(m: Awaited<ReturnType<typeof byCode>>, opts: { template?: string; lang?: string }) {
  if (isBuilding(m.id)) throw new HttpError(409, "The report is already being written.");
  const segs = await db.meetSegment.count({ where: { meetingId: m.id } });
  const caps = segs ? 0 : await db.meetCaption.count({ where: { meetingId: m.id } });
  await db.meeting.update({ where: { id: m.id }, data: { notesStatus: "processing", notesError: "", ...(opts.template ? { template: opts.template } : {}), ...(opts.lang !== undefined ? { reportLang: opts.lang } : {}) } });
  if (segs || caps || m.transcript.trim()) {
    void buildReport(m.id, opts).catch(() => null);
    return { ok: true };
  }
  // Uploaded or captured media that never got a transcript: transcribe again.
  const rec = await db.meetRecording.findFirst({ where: { meetingId: m.id, kind: "upload", status: "complete", deletedAt: null }, orderBy: { startedAt: "desc" } });
  if (rec) {
    void ingestAudio(m.id, recordingPath(rec), { mime: path.extname(rec.file) === ".mp4" ? "video/mp4" : undefined }).catch(() => null);
    return { ok: true };
  }
  const { generateNotes } = await import("@/lib/meet/notes");
  void generateNotes(m.id);
  return { ok: true };
}

async function POST_(req: Request, ctx: Ctx) {
  const me = await getMe();
  const m = await byCode((await ctx.params).code);
  if (!(await canSeeMeetingReport(me, m))) throw new HttpError(404, "Not found");
  const b = await body<{ action?: string; template?: string; lang?: string; from?: string; to?: string; emails?: string[] }>(req);
  if (b.action === "translate") return Response.json({ report: await translateReport(m, String(b.lang ?? ""), me!.userId) });
  const host = requireRecorder(me, m, "audio");
  if (b.action === "regenerate" || b.action === "template") {
    const template = b.template ? (await resolveTemplate(m.ws, b.template)).id : undefined;
    if (b.template && template !== b.template) bad("That template doesn't exist.");
    const lang = b.lang === undefined ? undefined : String(b.lang).trim().slice(0, 40);
    if (b.action === "template" && m.notesStatus !== "ready") {
      // Before the report exists: just remember the choice.
      await db.meeting.update({ where: { id: m.id }, data: { template: template ?? m.template } });
      return Response.json({ ok: true, saved: true });
    }
    return Response.json(await remake(m, { template, lang }));
  }
  if (b.action === "rename") return Response.json(await renameSpeaker(m, String(b.from ?? ""), String(b.to ?? "")));
  if (b.action === "share") {
    const emails = (b.emails ?? []).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)).slice(0, 50);
    if (!emails.length) bad("Enter the email of someone in your organization.");
    const users = await db.user.findMany({ where: { email: { in: emails, mode: "insensitive" } }, select: { id: true, email: true } });
    const members = await db.member.findMany({ where: { ws: host.ws, userId: { in: users.map((u) => u.id) } }, select: { userId: true } });
    const ids = members.map((x) => x.userId).filter((id) => id !== m.hostId);
    // Shares are helper B's MeetReportShare rows (canSeeReport reads them).
    const { shareReport } = await import("@/lib/meet/read");
    const r = ids.length ? await shareReport(host, m.code, ids) : { shared: 0 };
    const missing = emails.filter((e) => !users.some((u) => u.email.toLowerCase() === e && ids.includes(u.id)));
    return Response.json({ ok: true, shared: r.shared, missing });
  }
  bad("Unknown action.");
}

export const GET = route(GET_);
export const POST = route(POST_);
