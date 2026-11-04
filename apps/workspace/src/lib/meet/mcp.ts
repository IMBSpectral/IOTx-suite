import type { Meeting } from "@prisma/client";
import { db } from "../db";
import { HttpError, type Me } from "../auth";
import { reportUrl } from "./external";
import { canSeeReport, reportOf, visibleReports, type Report } from "./read";
import { ownedBy } from "./insights";

/**
 * MCP server for meeting reports ("Connect Read to Claude / ChatGPT"):
 * Streamable HTTP at /workspace/api/mcp, JSON-RPC 2.0 over POST, answered
 * with plain JSON (no SSE stream: every tool answers at once). Signed in with
 * an ExtensionToken (Meet → Integrations → API tokens) as
 * "Authorization: Bearer iotxr_…". Tools: search_meetings, get_report,
 * list_action_items; each only sees reports the person may see (canSeeReport).
 */

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "iotx-meet", title: "IOTx Meet reports", version: "1.0.0" };

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcReply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const TOOLS = [
  {
    name: "search_meetings",
    title: "Search meetings",
    description: "Search the meeting reports you can see (titles, summaries, topics and transcripts). Returns the newest matches with their id, date, summary and link.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for. Leave empty to list recent meetings." },
        from: { type: "string", description: "Only meetings on or after this date (YYYY-MM-DD)." },
        to: { type: "string", description: "Only meetings before this date (YYYY-MM-DD)." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many (default 10)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_report",
    title: "Get a meeting report",
    description: "The full report of one meeting: summary, chapters, action items, key questions, decisions, topics, highlights, scores, and optionally the transcript.",
    inputSchema: {
      type: "object",
      properties: {
        meeting: { type: "string", description: "The meeting id or code (abc-defg-hij) from search_meetings." },
        transcript: { type: "boolean", description: "Include the timestamped transcript (default false)." },
      },
      required: ["meeting"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_action_items",
    title: "List action items",
    description: "Action items from the reports of recent meetings you can see, newest first, with owner, due date and the meeting they came from.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 90, description: "How far back (default 14 days)." },
        mine: { type: "boolean", description: "Only items owned by me (default false)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

class ParamError extends Error {}
const day = (v: unknown) => {
  if (v === undefined || v === null || v === "") return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ParamError(`"${String(v)}" isn't a date (YYYY-MM-DD).`);
  return d;
};
const whenOf = (m: Meeting) => (m.startedAt ?? m.createdAt).toISOString();
const textOf = (m: Meeting, r: Report) => [m.title, r.summary, ...r.topics, ...r.decisions, ...r.actionItems.map((a) => a.title)].join("\n").toLowerCase();

async function searchMeetings(me: Me, a: Record<string, unknown>) {
  const limit = Math.min(50, Math.max(1, Number(a.limit) || 10));
  const q = String(a.query ?? "").trim().toLowerCase().slice(0, 200);
  const rows = await visibleReports(me, { from: day(a.from), to: day(a.to) });
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  let hits = rows;
  if (words.length) {
    // Title, summary and topics first; the transcript (one query for the rest) catches what a report left out.
    const inReport = rows.filter(({ m, r }) => words.every((w) => textOf(m, r).includes(w)));
    const others = rows.filter((x) => !inReport.includes(x));
    const viaText = others.length
      ? new Set((await db.meeting.findMany({ where: { id: { in: others.map((x) => x.m.id) }, AND: words.map((w) => ({ transcript: { contains: w, mode: "insensitive" as const } })) }, select: { id: true } })).map((x) => x.id))
      : new Set<string>();
    const viaSeg = others.length
      ? new Set((await db.meetSegment.findMany({ where: { meetingId: { in: others.map((x) => x.m.id).filter((id) => !viaText.has(id)) }, text: { contains: words[0], mode: "insensitive" } }, select: { meetingId: true }, distinct: ["meetingId"] })).map((x) => x.meetingId))
      : new Set<string>();
    hits = [...inReport, ...others.filter((x) => viaText.has(x.m.id) || viaSeg.has(x.m.id))];
  }
  const meetings = hits.slice(0, limit).map(({ m, r }) => ({ id: m.id, code: m.code, title: m.title, kind: m.kind, date: whenOf(m), summary: r.summary.slice(0, 600), topics: r.topics, actionItems: r.actionItems.length, url: reportUrl(m.code) }));
  const text = meetings.length
    ? meetings.map((x, i) => `${i + 1}. ${x.title} — ${x.date.slice(0, 16).replace("T", " ")} UTC (id ${x.id}, code ${x.code})\n   ${x.summary.slice(0, 300)}\n   ${x.url}`).join("\n")
    : "No meetings matched.";
  return { text, structured: { meetings } };
}

async function findMeeting(me: Me, key: string) {
  const k = key.trim();
  const m = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(k) ? await db.meeting.findUnique({ where: { code: k } }) : await db.meeting.findUnique({ where: { id: k } });
  if (!m || !(await canSeeReport(me, m))) throw new ParamError("No meeting with that id or code that you can see.");
  return m;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function getReport(me: Me, a: Record<string, unknown>) {
  if (!a.meeting) throw new ParamError("meeting is required.");
  const m = await findMeeting(me, String(a.meeting));
  const r = reportOf(m);
  if (!r) return { text: `"${m.title}" has no report yet (status: ${m.notesStatus || "none"}).`, structured: { meeting: { id: m.id, code: m.code, title: m.title }, report: null } };
  let transcript: { start: number; end: number; speaker: string; text: string }[] | undefined;
  if (a.transcript) {
    const segs = await db.meetSegment.findMany({ where: { meetingId: m.id }, orderBy: { seq: "asc" }, select: { start: true, end: true, speaker: true, text: true } });
    let size = 0;
    transcript = [];
    for (const s of segs) {
      size += s.text.length + 30;
      if (size > 60_000) break;
      transcript.push(s);
    }
  }
  const lines = [
    `# ${m.title}`, `${whenOf(m).slice(0, 16).replace("T", " ")} UTC · ${m.kind}${m.durationSec ? ` · ${Math.round(m.durationSec / 60)} min` : ""}`, "",
    "## Summary", r.summary,
    ...(r.chapters.length ? ["", "## Chapters", ...r.chapters.map((c) => `- [${clock(c.start)}] ${c.title}: ${c.summary}`)] : []),
    ...(r.actionItems.length ? ["", "## Action items", ...r.actionItems.map((x) => `- ${x.title}${x.owner ? ` (${x.owner})` : ""}${x.due ? ` by ${x.due}` : ""}`)] : []),
    ...(r.keyQuestions.length ? ["", "## Key questions", ...r.keyQuestions.map((x) => `- ${x.question}${x.askedBy ? ` (${x.askedBy})` : ""}${x.answered ? "" : " — not answered"}`)] : []),
    ...(r.decisions.length ? ["", "## Decisions", ...r.decisions.map((d) => `- ${d}`)] : []),
    ...(r.topics.length ? ["", `Topics: ${r.topics.join(", ")}`] : []),
    ...(r.sections.length ? r.sections.flatMap((s) => ["", `## ${s.title}`, s.body]) : []),
    ...(transcript ? ["", "## Transcript", ...transcript.map((s) => `[${clock(s.start)}] ${s.speaker}: ${s.text}`)] : []),
    "", reportUrl(m.code),
  ];
  return { text: lines.join("\n"), structured: { meeting: { id: m.id, code: m.code, title: m.title, kind: m.kind, date: whenOf(m), durationSec: m.durationSec, url: reportUrl(m.code) }, report: r, ...(transcript ? { transcript } : {}) } };
}

async function listActionItems(me: Me, a: Record<string, unknown>) {
  const days = Math.min(90, Math.max(1, Number(a.days) || 14));
  const rows = await visibleReports(me, { from: new Date(Date.now() - days * 86_400_000) });
  const items = rows.flatMap(({ m, r }) => r.actionItems.map((x) => ({ title: x.title, owner: x.owner, due: x.due, meeting: { id: m.id, code: m.code, title: m.title, date: whenOf(m) }, url: reportUrl(m.code) })));
  const out = a.mine ? items.filter((x) => ownedBy(x.owner, me)) : items;
  const text = out.length ? out.map((x) => `- ${x.title}${x.owner ? ` — ${x.owner}` : ""}${x.due ? `, due ${x.due}` : ""} (from "${x.meeting.title}", ${x.meeting.date.slice(0, 10)})`).join("\n") : `No action items in the last ${days} days.`;
  return { text, structured: { items: out } };
}

async function callTool(me: Me, name: string, args: Record<string, unknown>) {
  const fn = name === "search_meetings" ? searchMeetings : name === "get_report" ? getReport : name === "list_action_items" ? listActionItems : null;
  if (!fn) return null;
  try {
    const r = await fn(me, args);
    return { content: [{ type: "text", text: r.text }], structuredContent: r.structured, isError: false };
  } catch (e) {
    // Tool errors go back to the model as results it can act on (MCP: isError), not protocol errors.
    if (e instanceof ParamError || e instanceof HttpError) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
}

/** One JSON-RPC message; null for notifications (no reply). */
export async function handleRpc(me: Me, msg: Rpc): Promise<RpcReply | null> {
  const id = msg?.id ?? null;
  const err = (code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(-32600, "Invalid Request");
  const notification = msg.id === undefined;
  if (notification) return null; // notifications/initialized, notifications/cancelled…
  const p = (msg.params ?? {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize": {
      const asked = String(p.protocolVersion ?? "");
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: `Meeting reports from IOTx Meet for ${me.name}. Use search_meetings to find meetings, get_report for one meeting's report, and list_action_items for follow-ups.`,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = String(p.name ?? "");
      const args = p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {};
      const r = await callTool(me, name, args);
      if (!r) return err(-32602, `Unknown tool: ${name}`);
      return { jsonrpc: "2.0", id, result: r };
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return err(-32601, `Method not found: ${msg.method}`);
  }
}
