import { HttpError, requireMe } from "@/lib/auth";
import { bad, body, route, str } from "@/lib/http";
import { MEET_KEYS } from "@/lib/meet/meetings";
import * as read from "@/lib/meet/read";
import { actionToTask, coaching, forYou, periodOf, policy } from "@/lib/meet/insights";
import { ask, deleteThread, gather, suggestions, thread, threads } from "@/lib/meet/ask";
import { flexibleOf, listRecommendations, reviewRecommendation, setFlexible } from "@/lib/meet/recommend";
import { dailyFor, sendDigest } from "@/lib/meet/daily";

export const dynamic = "force-dynamic";

/**
 * Meet across meetings (Read AI parity, helper B). Everything is as the
 * signed-in person and only over reports they may see (canSeeReport).
 *   GET  foryou?days= · coaching?days=&user= · policy?days=&scope=me|workspace
 *        reports?days=&q= · recommendations?tab=new|reviewed&refresh=1
 *        folders · folders/<id> · ask/suggestions · ask/search?q=&folder= (sources, no AI) · ask/threads?folder= · ask/threads/<id>
 *        settings · daily · flexible?eventId= · recap?code=
 *   POST ask { question, threadId?, folderId? } · actions/task { code, idx, projectId? }
 *        recommendations/<id> { action: accept|ignore } · folders { name, kind, members?, rules? }
 *        folders/<id> (PATCH) · folders/<id>/items { codes } · share { code, userIds }
 *        settings { dailyRead?, dailyHour?, recapTo?, optOut? } · daily/send · flexible { eventId, on }
 *        optout { code, email, name } and optout/confirm { token } (no sign-in: people outside)
 *   DELETE folders/<id> · folders/<id>/items?code= · share?code=&user= · ask/threads/<id>
 */
type Ctx = { params: Promise<{ p: string[] }> };

async function GET_(req: Request, ctx: Ctx) {
  const [a, b] = (await ctx.params).p;
  const me = await requireMe(MEET_KEYS.open);
  const q = new URL(req.url).searchParams;
  switch (a) {
    case "foryou":
      return Response.json(await forYou(me, periodOf(q)));
    case "coaching":
      return Response.json(await coaching(me, periodOf(q), q.get("user") || undefined));
    case "policy":
      return Response.json(await policy(me, periodOf(q), q.get("scope") === "workspace" ? "workspace" : "me"));
    case "reports": {
      const reps = await read.visibleReports(me, q.get("days") ? periodOf(q) : {});
      const t = (q.get("q") ?? "").toLowerCase();
      return Response.json({ reports: reps.filter((x) => !t || x.m.title.toLowerCase().includes(t)).slice(0, 200).map((x) => read.reportRow(x.m, x.r)) });
    }
    case "recommendations":
      return Response.json({ items: await listRecommendations(me, q.get("tab") === "reviewed" ? "reviewed" : "new", q.get("refresh") === "1") });
    case "folders":
      return Response.json(b ? await read.folderReports(me, b) : { folders: await read.listFolders(me) });
    case "ask":
      if (b === "suggestions") return Response.json({ prompts: await suggestions(me) });
      // What Ask would draw on for a question, without the model (sources only).
      if (b === "search") return Response.json(await gather(me, str(q.get("q"), 2000), { folderId: q.get("folder") || undefined }));
      if (b === "threads") {
        const id = (await ctx.params).p[2];
        return Response.json(id ? { thread: await thread(me, id) } : { threads: await threads(me, q.get("folder") || undefined) });
      }
      break;
    case "settings":
      return Response.json({
        prefs: await read.readPrefs(me), recap: await read.readSettings(me.ws), optedOut: await read.myOptOut(me), admin: read.isReadAdmin(me),
        email: me.email,
      });
    case "daily":
      return Response.json(await dailyFor(me));
    case "flexible":
      return Response.json(await flexibleOf(me, str(q.get("eventId"), 60)));
    case "recap": {
      const m = await read.meetingByCode(me, str(q.get("code"), 20));
      return Response.json({ recapTo: (await read.readSettings(me.ws)).recapTo, userIds: await read.recapRecipients(m.id) });
    }
  }
  throw new HttpError(404, "Not found");
}

async function POST_(req: Request, ctx: Ctx) {
  const [a, b, c] = (await ctx.params).p;
  // People outside the workspace opt out of being summarised (confirmed by email).
  if (a === "optout") {
    const x = await body<{ code?: string; email?: string; name?: string; token?: string }>(req);
    if (b === "confirm") return Response.json(await read.confirmOptOut(String(x.token ?? "")));
    const origin = (process.env.PUBLIC_ORIGIN || process.env.WORKSPACE_PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, "");
    return Response.json(await read.requestOptOut(x, origin));
  }
  const me = await requireMe(MEET_KEYS.open);
  const x = await body<Record<string, unknown>>(req);
  switch (a) {
    case "ask":
      return Response.json(await ask(me, { question: str(x.question, 2000), threadId: str(x.threadId, 60) || undefined, folderId: str(x.folderId, 60) || undefined }));
    case "actions":
      if (b === "task") return Response.json(await actionToTask(me, { code: str(x.code, 20), idx: Number(x.idx), projectId: str(x.projectId, 60) || undefined }));
      break;
    case "recommendations":
      if (!b) break;
      return Response.json(await reviewRecommendation(me, b, x.action === "accept" ? "accept" : x.action === "ignore" ? "ignore" : bad("accept or ignore")));
    case "folders":
      if (!b) return Response.json({ folder: await read.createFolder(me, x as never) }, { status: 201 });
      if (c === "items") return Response.json(await read.addToFolder(me, b, Array.isArray(x.codes) ? x.codes.map(String) : [str(x.code, 20)]));
      return Response.json({ folder: await read.updateFolder(me, b, x as never) });
    case "share":
      return Response.json(await read.shareReport(me, str(x.code, 20), Array.isArray(x.userIds) ? x.userIds.map(String) : []));
    case "settings": {
      const out: Record<string, unknown> = {};
      if (x.dailyRead !== undefined || x.dailyHour !== undefined) out.prefs = await read.saveReadPrefs(me, { dailyRead: x.dailyRead as boolean | undefined, dailyHour: x.dailyHour as number | undefined });
      if (x.recapTo !== undefined) out.recap = await read.saveReadSettings(me, { recapTo: str(x.recapTo, 20) });
      if (x.optOut !== undefined) out.optedOut = (await read.setMyOptOut(me, !!x.optOut)).optedOut;
      return Response.json(out);
    }
    case "daily":
      if (b === "send") return Response.json(await sendDigest(me));
      break;
    case "flexible":
      return Response.json(await setFlexible(me, str(x.eventId, 60), !!x.on));
  }
  throw new HttpError(404, "Not found");
}

async function PATCH_(req: Request, ctx: Ctx) {
  const [a, b] = (await ctx.params).p;
  const me = await requireMe(MEET_KEYS.open);
  if (a === "folders" && b) return Response.json({ folder: await read.updateFolder(me, b, await body(req)) });
  throw new HttpError(404, "Not found");
}

async function DELETE_(req: Request, ctx: Ctx) {
  const [a, b, c] = (await ctx.params).p;
  const me = await requireMe(MEET_KEYS.open);
  const q = new URL(req.url).searchParams;
  if (a === "folders" && b && c === "items") return Response.json(await read.removeFromFolder(me, b, str(q.get("code"), 20)));
  if (a === "folders" && b) return Response.json(await read.deleteFolder(me, b));
  if (a === "share") return Response.json(await read.unshareReport(me, str(q.get("code"), 20), str(q.get("user"), 60)));
  if (a === "ask" && b === "threads" && c) return Response.json(await deleteThread(me, c));
  throw new HttpError(404, "Not found");
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
