import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { can, HttpError, type Me } from "../auth";
import { bad, str } from "../http";
import { consultKnowledge } from "../kb";
import { reportHref, visibleMeetingIds, visibleReports, whenOf } from "./read";
import { meteredFetch } from "../ai-meter";

/**
 * Ask (across meetings): questions answered from every report and transcript
 * the person may see (Postgres full text over MeetSegment rows, report
 * summaries and chapters, and older plain transcripts), the company
 * knowledge base (consult first), and Tasks and Chat where they have
 * access. Claude Sonnet 5.5 answers with citations; meeting citations link
 * to the report at the moment.
 */

const MODEL = "claude-sonnet-5-5";
let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ fetch: meteredFetch("Meet: ask") }));

const STOP = new Set(["the", "and", "for", "with", "what", "how", "who", "why", "when", "where", "which", "our", "does", "are", "was", "were", "is", "do", "did", "we", "you", "your", "my", "me", "i", "of", "to", "in", "on", "an", "a", "it", "its", "be", "by", "or", "as", "at", "this", "that", "about", "can", "should", "use", "us", "from", "last", "week", "weeks", "meeting", "meetings", "there", "any", "have", "has", "had", "tell", "say", "said", "talk", "talked", "discuss", "discussed", "right", "now", "currently", "major", "next", "steps", "get", "give"]);

/** The question's words, safe for to_tsquery: prefixes for longer words, exact short ones, no filler words. */
export function queryWords(q: string) {
  const all = [...new Set(q.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2))];
  const ws = all.filter((w) => !STOP.has(w));
  return ws.slice(0, 16).map((w) => (w.length >= 4 ? `${w}:*` : w));
}

export type MeetHit = { kind: "segment" | "summary" | "chapter" | "transcript"; meetingId: string; code: string; title: string; at: Date; start: number | null; who: string; text: string; rank: number };

/**
 * Passages from these meetings that answer a question, best first. A passage
 * counts only when it has at least half of the question's words (at most 3
 * for long questions), like the knowledge base search, so one stray word
 * isn't an answer. Rank: coverage plus cover density; summaries and chapters
 * get a small boost.
 */
export async function searchMeetings(ids: string[], question: string, limit = 12): Promise<MeetHit[]> {
  const words = queryWords(question);
  if (!ids.length || !words.length) return [];
  const tsq = words.join(" | ");
  const need = Math.max(1, Math.min(3, Math.ceil(words.length / 2)));
  const n = words.length;
  const rows = await db.$queryRaw<MeetHit[]>`
    SELECT * FROM (
      SELECT 'segment' AS kind, s."meetingId", m.code, m.title, COALESCE(m."startedAt", m."createdAt") AS at, s.start::float AS start, s.speaker AS who, s.text,
        (c.n::float / ${n} + LEAST(ts_rank_cd(v, q, 1), 1))::float AS rank
      FROM meet_segments s JOIN meetings m ON m.id = s."meetingId",
        to_tsquery('english', ${tsq}) q,
        LATERAL to_tsvector('english', s.text) v,
        LATERAL (SELECT count(*) AS n FROM unnest(${words}::text[]) w WHERE v @@ to_tsquery('english', w)) c
      WHERE s."meetingId" = ANY(${ids}) AND v @@ q AND c.n >= ${need}
    UNION ALL
      SELECT 'summary', m.id, m.code, m.title, COALESCE(m."startedAt", m."createdAt"), NULL::float, '', COALESCE(m.report->>'summary', m.notes->>'summary', ''),
        (c.n::float / ${n} + LEAST(ts_rank_cd(v, q, 1), 1) + 0.3)::float
      FROM meetings m,
        to_tsquery('english', ${tsq}) q,
        LATERAL to_tsvector('english', m.title || ' ' || COALESCE(m.report->>'summary', m.notes->>'summary', '')) v,
        LATERAL (SELECT count(*) AS n FROM unnest(${words}::text[]) w WHERE v @@ to_tsquery('english', w)) c
      WHERE m.id = ANY(${ids}) AND v @@ q AND c.n >= ${need}
    UNION ALL
      SELECT 'chapter', m.id, m.code, m.title, COALESCE(m."startedAt", m."createdAt"), NULLIF(ch->>'start', '')::float, ch->>'title', (ch->>'title') || ': ' || COALESCE(ch->>'summary', ''),
        (c.n::float / ${n} + LEAST(ts_rank_cd(v, q, 1), 1) + 0.2)::float
      FROM meetings m
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.report->'chapters') = 'array' THEN m.report->'chapters' ELSE '[]'::jsonb END) ch,
        to_tsquery('english', ${tsq}) q,
        LATERAL to_tsvector('english', COALESCE(ch->>'title', '') || ' ' || COALESCE(ch->>'summary', '')) v,
        LATERAL (SELECT count(*) AS n FROM unnest(${words}::text[]) w WHERE v @@ to_tsquery('english', w)) c
      WHERE m.id = ANY(${ids}) AND v @@ q AND c.n >= ${need}
    UNION ALL
      SELECT 'transcript', m.id, m.code, m.title, COALESCE(m."startedAt", m."createdAt"), NULL::float, '',
        ts_headline('english', m.transcript, q, 'MaxWords=45, MinWords=20, MaxFragments=2, FragmentDelimiter=" … "'),
        (c.n::float / ${n} + LEAST(ts_rank_cd(v, q, 1), 1) - 0.1)::float
      FROM meetings m,
        to_tsquery('english', ${tsq}) q,
        LATERAL to_tsvector('english', m.transcript) v,
        LATERAL (SELECT count(*) AS n FROM unnest(${words}::text[]) w WHERE v @@ to_tsquery('english', w)) c
      WHERE m.id = ANY(${ids}) AND m.transcript <> '' AND NOT EXISTS (SELECT 1 FROM meet_segments x WHERE x."meetingId" = m.id)
        AND v @@ q AND c.n >= ${need}
    ) r
    ORDER BY rank DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, rank: Number(r.rank), start: r.start == null ? null : Number(r.start) }));
}

/** "last week", "yesterday", "this month"… in a question: that window, for summaries by date. */
export function windowOf(q: string, now = new Date()): { from: Date; to: Date; label: string } | null {
  const t = q.toLowerCase();
  const day = 86_400_000;
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (/\byesterday\b/.test(t)) return { from: new Date(startOfDay.getTime() - day), to: startOfDay, label: "yesterday" };
  if (/\btoday\b/.test(t)) return { from: startOfDay, to: new Date(startOfDay.getTime() + day), label: "today" };
  if (/\blast week\b|\bpast week\b|\bprevious week\b/.test(t)) {
    const dow = (startOfDay.getUTCDay() + 6) % 7;
    const thisMon = new Date(startOfDay.getTime() - dow * day);
    return { from: new Date(thisMon.getTime() - 7 * day), to: thisMon, label: "last week" };
  }
  if (/\bthis week\b/.test(t)) {
    const dow = (startOfDay.getUTCDay() + 6) % 7;
    return { from: new Date(startOfDay.getTime() - dow * day), to: new Date(now.getTime() + day), label: "this week" };
  }
  const m = /\b(?:past|last)\s+(\d{1,2})\s+days\b/.exec(t);
  if (m) return { from: new Date(now.getTime() - Number(m[1]) * day), to: now, label: `the past ${m[1]} days` };
  if (/\b(this|last|past) month\b/.test(t)) return { from: new Date(now.getTime() - 30 * day), to: now, label: "the past month" };
  if (/\brecent(ly)?\b|\blatest\b|\bworking on\b|\bright now\b|\bnext steps\b|\bat risk\b|\boverdue\b/.test(t)) return { from: new Date(now.getTime() - 14 * day), to: now, label: "the past two weeks" };
  return null;
}

type Source = { ref: string; kind: "meeting" | "task" | "chat" | "kb"; title: string; href: string; at?: string; text: string };

/** What Ask can draw on for this question, as numbered sources (M = meetings, T = tasks, C = chat). */
export async function gather(me: Me, question: string, o: { folderId?: string } = {}) {
  if (o.folderId) {
    const f = await db.meetFolder.findUnique({ where: { id: o.folderId } });
    if (!f || f.ws !== me.ws || (f.ownerId !== me.userId && !f.members.includes(me.userId))) throw new HttpError(404, "Folder not found");
  }
  const ids = await visibleMeetingIds(me, { folderId: o.folderId });
  const hits = await searchMeetings(ids, question, 12);
  const sources: Source[] = [];
  const fmtAt = (d: Date) => d.toISOString().slice(0, 10);
  const mm = (s: number | null) => (s == null ? "" : ` @ ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
  for (const h of hits) {
    sources.push({
      ref: `M${sources.length + 1}`, kind: "meeting", title: `${h.title} (${fmtAt(new Date(h.at))}${mm(h.start)})`, href: reportHref(h.code, h.start), at: new Date(h.at).toISOString(),
      text: `${h.kind === "segment" ? `${h.who}: ` : h.kind === "summary" ? "Summary: " : h.kind === "chapter" ? "Chapter " : "Transcript: "}${h.text}`.slice(0, 900),
    });
  }
  // Questions about a time ("last week", "right now"): the summaries of meetings then, newest first.
  const win = windowOf(question);
  if (win) {
    const reps = await visibleReports(me, { from: win.from, to: win.to, folderId: o.folderId, take: 12 });
    for (const { m, r } of reps) {
      if (sources.some((s) => s.href === reportHref(m.code) && s.text.startsWith("Summary"))) continue;
      const extra = [r.actionItems.length ? `Action items: ${r.actionItems.map((a) => `${a.title}${a.owner ? ` (${a.owner})` : ""}`).join("; ")}` : "", r.decisions.length ? `Decisions: ${r.decisions.join("; ")}` : ""].filter(Boolean).join("\n");
      sources.push({ ref: `M${sources.length + 1}`, kind: "meeting", title: `${m.title} (${fmtAt(whenOf(m))})`, href: reportHref(m.code), at: whenOf(m).toISOString(), text: `Summary: ${r.summary}\n${extra}`.slice(0, 1200) });
    }
  }
  const kw = queryWords(question).map((w) => w.replace(/:\*$/, "")).sort((a, b) => b.length - a.length).slice(0, 3);
  // Tasks and Chat only outside folders (a folder's Ask is about its reports).
  if (!o.folderId && can(me, "tasks.open")) {
    const wantMine = /\b(my|me|i)\b.*\b(task|tasks|next steps|overdue|risk|due)\b|\b(overdue|at risk)\b/i.test(question);
    const tasks = await db.task.findMany({
      where: {
        ws: me.ws, project: { archived: false, members: { some: { userId: me.userId } } },
        OR: [...kw.map((w) => ({ title: { contains: w, mode: "insensitive" as const } })), ...(wantMine ? [{ assigneeId: me.userId, completedAt: null }] : [])],
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: { project: { select: { name: true, key: true, statuses: true } } },
    });
    const now = Date.now();
    for (const t of kw.length || wantMine ? tasks : []) {
      const overdue = !t.completedAt && t.due && t.due.getTime() < now;
      sources.push({
        ref: `T${sources.filter((s) => s.kind === "task").length + 1}`, kind: "task", title: `${t.project.key ? `${t.project.key}-${t.number} ` : ""}${t.title}`, href: `/workspace/tasks?project=${t.projectId}&task=${t.id}`,
        text: `Task in ${t.project.name}: ${t.title}. Status: ${t.completedAt ? "done" : t.status}${t.due ? `, due ${t.due.toISOString().slice(0, 10)}${overdue ? " (overdue)" : ""}` : ""}${t.assigneeId === me.userId ? ", assigned to you" : ""}.`,
      });
    }
  }
  if (!o.folderId && can(me, "teamchat.open") && kw.length) {
    const { search } = await import("../chat");
    const seen = new Set<string>();
    for (const w of kw.slice(0, 2)) {
      const msgs = await search(me, w).catch(() => []);
      for (const m of msgs.slice(0, 4)) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        sources.push({
          ref: `C${sources.filter((s) => s.kind === "chat").length + 1}`, kind: "chat", title: m.channelKind === "dm" ? "Direct message" : `#${m.channelName}`,
          href: `/workspace/chat?channel=${m.channelId}&message=${m.id}${m.parentId ? `&thread=${m.parentId}` : ""}`, at: new Date(m.createdAt).toISOString(), text: String(m.body).slice(0, 400),
        });
      }
    }
  }
  return { sources, meetings: ids.length };
}

/** Read's suggested prompts, filled in with this person's team and project. */
export async function suggestions(me: Me) {
  const project = can(me, "tasks.open")
    ? await db.project.findFirst({ where: { ws: me.ws, archived: false, members: { some: { userId: me.userId } } }, orderBy: { createdAt: "desc" }, select: { name: true } })
    : null;
  const group = await db.userGroup.findFirst({ where: { ws: me.ws, memberIds: { has: me.userId } }, select: { name: true } });
  return [
    "What are the major takeaways from last week's meetings?",
    `What is the ${group?.name ?? "team"} team working on right now?`,
    `What are my next steps on the ${project?.name ?? "current"} project?`,
    "What tasks are currently at risk or overdue?",
  ];
}

const SYSTEM = `You are Ask, the meeting assistant in a company workspace. Answer the person's question from the sources you are given: excerpts of meeting reports and transcripts they may see [M1], [M2]…, their tasks [T1]…, team chat messages [C1]…, and company knowledge [1], [2]….
- Use these sources first, and cite them. Where they don't cover the question, add your general knowledge to give a useful answer (without a label), and say plainly when a meeting or company detail isn't in the sources rather than guessing it.
- Cite every fact with its source label in square brackets right after it, e.g. "The launch moved to May [M2]." Never invent labels.
- Be brief: a few sentences or short bullet points. Name people and dates when the sources do.
- Meeting excerpts are what people said; don't present them as decided unless a source says so.`;

/** Ask a question (in a thread, optionally inside a folder): the answer with its sources, saved to the history. */
export async function ask(me: Me, b: { question?: string; threadId?: string; folderId?: string }) {
  const question = str(b.question, 2000);
  if (question.length < 2) bad("Ask a question.");
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "Ask isn't set up on this server (ANTHROPIC_API_KEY is missing).");
  let thread = b.threadId ? await db.meetAskThread.findUnique({ where: { id: b.threadId }, include: { messages: { orderBy: { createdAt: "asc" } } } }) : null;
  if (b.threadId && (!thread || thread.userId !== me.userId || thread.ws !== me.ws)) throw new HttpError(404, "Not found");
  const folderId = thread?.folderId ?? (b.folderId || undefined);
  const { sources, meetings } = await gather(me, question, { folderId });
  // Knowledge first (as the person): company articles they may read.
  const kb = await consultKnowledge(me, question, { context: "Meeting reports" });
  const block = sources.map((s) => `[${s.ref}] ${s.title}\n${s.text}`).join("\n\n");
  const history = (thread?.messages ?? []).slice(-6).map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.text }));
  const content = `${kb.context}\n\nSources from meetings, tasks and chat (${meetings} meeting${meetings === 1 ? "" : "s"} searched${folderId ? ", in this folder only" : ""}):\n${block || "(nothing matched)"}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\nQuestion: ${question}`;
  let answer = "";
  try {
    const r = await anthropic().messages.create({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [...history, { role: "user", content }] });
    if (r.stop_reason === "refusal") throw new HttpError(422, "The AI declined to answer this question.");
    answer = r.content.map((x) => (x.type === "text" ? x.text : "")).join("").trim();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The AI key on this server isn't valid.");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service answered ${e.status ?? "an error"}.`);
    throw e;
  }
  if (!answer) throw new HttpError(502, "The AI returned an empty answer. Try again.");
  const kbSources: Source[] = kb.hits.map((h, i) => ({ ref: String(i + 1), kind: "kb", title: h.title, href: h.platform ? "" : `/knowledge?doc=${h.docId}`, text: h.heading }));
  const used = [...sources, ...kbSources].filter((s) => answer.includes(`[${s.ref}]`)).map(({ text: _t, ...s }) => s);
  if (!thread) thread = { ...(await db.meetAskThread.create({ data: { ws: me.ws, userId: me.userId, title: question.slice(0, 80), folderId: folderId ?? null } })), messages: [] };
  await db.meetAskMessage.create({ data: { threadId: thread.id, role: "user", text: question } });
  const msg = await db.meetAskMessage.create({ data: { threadId: thread.id, role: "assistant", text: answer, sources: used } });
  await db.meetAskThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
  return { threadId: thread.id, message: { id: msg.id, role: "assistant", text: answer, sources: used }, searched: meetings, considered: sources.length };
}

export async function threads(me: Me, folderId?: string) {
  const ts = await db.meetAskThread.findMany({ where: { ws: me.ws, userId: me.userId, ...(folderId ? { folderId } : {}) }, orderBy: { updatedAt: "desc" }, take: 50 });
  return ts.map((t) => ({ id: t.id, title: t.title, folderId: t.folderId, updatedAt: t.updatedAt }));
}
export async function thread(me: Me, id: string) {
  const t = await db.meetAskThread.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: "asc" } } } });
  if (!t || t.userId !== me.userId || t.ws !== me.ws) throw new HttpError(404, "Not found");
  return { id: t.id, title: t.title, folderId: t.folderId, messages: t.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, sources: m.sources })) };
}
export async function deleteThread(me: Me, id: string) {
  const t = await db.meetAskThread.findUnique({ where: { id } });
  if (!t || t.userId !== me.userId) throw new HttpError(404, "Not found");
  await db.meetAskThread.delete({ where: { id } });
  return { ok: true };
}
