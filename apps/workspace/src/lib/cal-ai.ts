import Anthropic from "@anthropic-ai/sdk";
import { consultKnowledge } from "./kb";
import { db } from "./db";
import { HttpError, type Me } from "./auth";
import { createEvent, deleteEvent, loadEvent, occurrences, updateEvent, type EventInput } from "./calendar";
import {
  addDaysStr, at, dayWindow, directory, findSlots, fmtTime, fmtWhen, freeWindows, hoursOf, localDate, localHM, matchPeople,
  relatedTasks, weekdayOf, DEFAULT_HOURS, type Match, type Person, type Slot,
} from "./cal-smart";
import { suiteCall } from "./suite";
import { meteredFetch } from "./ai-meter";

/**
 * Calendar AI. Claude Haiku 5.5 parses (quick add, prep briefings), Claude
 * Sonnet 5.5 plans and uses tools (Ask Calendar, Plan my day). The AI never
 * writes to the calendar: every change comes back as a draft action that the
 * person confirms (POST /calendar/ai/apply). People are matched against the
 * workspace directory in code, never made up; a missing time is either left
 * for the person or, when they asked for one, picked from real free time and
 * labelled as a suggestion.
 */
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1, timeout: 60_000, fetch: meteredFetch("Calendar AI") }));

function ensureKey() {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "The calendar assistant isn't set up on this server.");
}

function aiError(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "The assistant is busy right now. Try again in a minute.");
  if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The AI key on this server isn't valid.");
  if (e instanceof Anthropic.APIConnectionError) throw new HttpError(502, "Couldn't reach the AI service. Try again.");
  if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service answered ${e.status ?? "an error"}.`);
  throw e;
}

const textOf = (m: Anthropic.Message) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();

/** One JSON answer from Haiku, shaped by a JSON schema (structured outputs); `company` is the knowledge-first block. */
async function haikuJson<T>(system: string, user: string, schema: Record<string, unknown>, company = ""): Promise<T> {
  ensureKey();
  try {
    const r = await anthropic().messages.create({
      model: HAIKU,
      max_tokens: 2000,
      system: company ? `${system}\n\n${company}` : system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    if (r.stop_reason === "refusal") throw new HttpError(422, "The assistant declined this request.");
    return JSON.parse(textOf(r).replace(/^```(?:json)?\s*|\s*```$/g, "")) as T;
  } catch (e) {
    if (e instanceof SyntaxError) throw new HttpError(502, "The assistant's answer couldn't be read. Try rephrasing.");
    aiError(e);
  }
}

/** Today, the next two weeks and the person's hours, so relative dates resolve against real dates. */
async function timeContext(me: Me) {
  const tz = me.tz || "UTC";
  const h = (await hoursOf([me.userId])).get(me.userId)?.hours ?? DEFAULT_HOURS;
  const today = localDate(Date.now(), tz);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const next = Array.from({ length: 15 }, (_, i) => {
    const d = addDaysStr(today, i);
    return `${names[weekdayOf(d)]} ${d}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`;
  }).join(", ");
  return {
    tz,
    hours: h,
    today,
    text: `Now: ${names[weekdayOf(today)]} ${today} ${localHM(Date.now(), tz)} in time zone ${tz}.\nThe next 15 days: ${next}.\nWorking hours: ${h.start}-${h.end} on ${h.days.map((d) => names[d]).join(", ")}; lunch ${h.lunchStart}-${h.lunchEnd}.`,
  };
}

const nullable = (t: string) => ({ type: [t, "null"] });

// ── 1 + 2. Quick add and "find the best time" ─────────────────────────────

type Parsed = {
  intent: "create" | "schedule" | "unclear";
  title: string;
  date: string | null;
  time: string | null;
  durationMinutes: number | null;
  allDay: boolean;
  location: string;
  attendees: string[];
  freq: "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  byDay: string[];
  interval: number;
  video: boolean;
  rangeStart: string | null;
  rangeEnd: string | null;
  dayPart: "morning" | "afternoon" | "any";
  note: string;
};

const PARSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "title", "date", "time", "durationMinutes", "allDay", "location", "attendees", "freq", "byDay", "interval", "video", "rangeStart", "rangeEnd", "dayPart", "note"],
  properties: {
    intent: { type: "string", enum: ["create", "schedule", "unclear"] },
    title: { type: "string" },
    date: nullable("string"),
    time: nullable("string"),
    durationMinutes: nullable("integer"),
    allDay: { type: "boolean" },
    location: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
    freq: { type: "string", enum: ["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"] },
    byDay: { type: "array", items: { type: "string", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] } },
    interval: { type: "integer" },
    video: { type: "boolean" },
    rangeStart: nullable("string"),
    rangeEnd: nullable("string"),
    dayPart: { type: "string", enum: ["morning", "afternoon", "any"] },
    note: { type: "string" },
  },
};

export type EventDraft = {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  tz: string;
  rrule: string | null;
  location: string;
  description: string;
  video: boolean;
  attendees: { userId: string | null; name: string; email: string }[];
  /** How the time was decided: typed by the person, or a suggestion from free time. */
  timeSource: "given" | "suggested";
  durationDefaulted: boolean;
};

export type QuickResult =
  | { kind: "event"; draft: EventDraft; match: Match; notes: string[]; conflicts: { name: string; title?: string }[] }
  | { kind: "slots"; title: string; minutes: number; from: string; to: string; people: Person[]; match: Match; slots: Slot[]; notes: string[] }
  | { kind: "unclear"; notes: string[] };

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d\d-\d\d$/.test(s);
const isTime = (s: string | null): s is string => !!s && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export async function quickAdd(me: Me, text: string): Promise<QuickResult> {
  const input = text.trim().slice(0, 500);
  if (input.length < 3) throw new HttpError(400, "Type what you want to add, for example “Review with Priya Friday 3pm”.");
  const [ctx, company] = await Promise.all([timeContext(me), consultKnowledge(me, input, { cite: false })]);
  const p = await haikuJson<Parsed>(
    `You read one short calendar request and return JSON. ${ctx.text}
Rules:
- intent "schedule" when they ask to find / suggest / pick the best time or a slot; "create" when they describe an event to add; "unclear" if it is not about the calendar.
- title: short and clean, without the date, time, people or place ("Review", "Standup", "Lunch with Priya" is fine if lunch is the point).
- date: YYYY-MM-DD from the list of the next 15 days (resolve "Friday", "tomorrow", "next Monday", "in 3 days"); null if no date is said. For a repeating event, the first date.
- time: HH:MM 24-hour only if a time or a time-of-day phrase is said. Phrases: "morning" 10:00, "noon" 12:00, "after lunch" = the end of lunch, "afternoon" 15:00, "evening" 18:00, "end of day" 30 minutes before the working day ends. Otherwise null. Never guess a time.
- durationMinutes: only if said ("45 min", "1 hour", "half an hour" 30); else null.
- attendees: the people exactly as written (names or emails). Never add anyone who is not written. Not the person themselves ("me", "I").
- freq/byDay/interval for repeats ("every Monday" WEEKLY MO, "weekdays" WEEKLY MO-FR, "every day" DAILY, "every other week" interval 2); else NONE, [], 1.
- video: true if they ask for a Meet / video / Zoom / call link.
- location: the place if said, else "".
- For "schedule": rangeStart/rangeEnd as dates ("next week" = its Monday to Saturday, "this week" = today to Saturday, "tomorrow" = tomorrow to tomorrow), else null; dayPart morning/afternoon if said, else any.
- note: one short line about anything ambiguous, else "".
- Company knowledge (below) may name the company's own days, places and terms (a holiday, an office); use it to resolve those, never to add people or times that weren't written.`,
    input,
    PARSE_SCHEMA,
    company.context,
  );
  const dir = await directory(me);
  const match = matchPeople(p.attendees ?? [], dir, me.userId);
  const notes: string[] = [];
  if (p.note) notes.push(p.note);
  for (const u of match.unmatched) notes.push(`No one called “${u}” in your workspace: not added.`);
  for (const a of match.ambiguous) notes.push(`“${a.mention}” could be ${a.options.map((o) => o.name).join(" or ")}: pick one.`);

  if (p.intent === "unclear") return { kind: "unclear", notes: notes.length ? notes : ["That doesn't look like something for the calendar."] };

  if (p.intent === "schedule") {
    const minutes = Math.max(15, Math.min(480, p.durationMinutes ?? 60));
    const from = isDate(p.rangeStart) && p.rangeStart >= ctx.today ? p.rangeStart : ctx.today;
    const to = isDate(p.rangeEnd) && p.rangeEnd >= from ? p.rangeEnd : addDaysStr(from, 6);
    const slots = await findSlots(me, match.matched.map((x) => x.id), from, to, minutes, { limit: 3, dayPart: p.dayPart === "any" ? null : p.dayPart });
    if (!p.durationMinutes) notes.push("No length given: looking for 1 hour.");
    if (!slots.length) notes.push("No time works for everyone in that range. Try a longer range or a shorter meeting.");
    return { kind: "slots", title: p.title || "Meeting", minutes, from, to, people: match.matched, match, slots, notes };
  }

  // create
  const tz = ctx.tz;
  const rrule = p.freq !== "NONE" ? `FREQ=${p.freq}${p.interval > 1 ? `;INTERVAL=${Math.min(p.interval, 12)}` : ""}${p.freq === "WEEKLY" && p.byDay.length ? `;BYDAY=${p.byDay.join(",")}` : ""}` : null;
  let date = isDate(p.date) ? p.date : null;
  if (!date && rrule && p.byDay.length) {
    const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    for (let i = 0; i < 8 && !date; i++) if (p.byDay.includes(codes[weekdayOf(addDaysStr(ctx.today, i))] as never)) date = addDaysStr(ctx.today, i);
  }
  if (!date) {
    date = ctx.today;
    notes.push("No date given: set for today. Change it if needed.");
  }
  const durationDefaulted = !p.durationMinutes && !p.allDay;
  const minutes = Math.max(5, Math.min(24 * 60, p.durationMinutes ?? 30));
  let start: Date, end: Date, timeSource: EventDraft["timeSource"] = "given";
  if (p.allDay) {
    start = new Date(`${date}T00:00:00.000Z`);
    end = new Date(start.getTime() + 86_400_000);
  } else if (isTime(p.time)) {
    start = at(date, p.time, tz);
    end = new Date(start.getTime() + minutes * 60_000);
  } else {
    const [s] = await findSlots(me, match.matched.map((x) => x.id), date, date, minutes, { limit: 1 });
    timeSource = "suggested";
    if (s) {
      start = new Date(s.start);
      end = new Date(s.end);
      notes.push(`No time given: suggested ${fmtTime(s.start, tz)}, the first time everyone is free.`);
    } else {
      start = at(date, ctx.hours.start, tz);
      end = new Date(start.getTime() + minutes * 60_000);
      notes.push("No time given and no free time that day: pick a time.");
    }
  }
  if (durationDefaulted) notes.push("No length given: 30 minutes.");
  if (p.video) notes.push("A video meeting was asked for: add the link before creating, or after in the event.");
  const attendees = [...match.matched.map((x) => ({ userId: x.id as string | null, name: x.name, email: x.email })), ...match.external.map((x) => ({ userId: null, name: "", email: x.email }))];
  const conflicts = p.allDay ? [] : await conflictsAt(me, [me.userId, ...match.matched.map((x) => x.id)], start, end, dir);
  return {
    kind: "event",
    draft: { title: p.title || "(No title)", start: start.toISOString(), end: end.toISOString(), allDay: p.allDay, tz, rrule, location: p.location ?? "", description: "", video: !!p.video, attendees, timeSource, durationDefaulted },
    match,
    notes,
    conflicts,
  };
}

async function conflictsAt(me: Me, ids: string[], start: Date, end: Date, dir: Person[]) {
  const { busy } = await import("./calendar");
  const b = await busy(me, ids, new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000));
  const out: { name: string }[] = [];
  for (const id of ids) if ((b[id] ?? []).some((x) => Date.parse(x.start) < end.getTime() && Date.parse(x.end) > start.getTime())) out.push({ name: id === me.userId ? "You" : dir.find((p) => p.id === id)?.name ?? "Someone" });
  return out;
}

export const draftToInput = (d: EventDraft, calendarId?: string): EventInput => ({
  calendarId,
  title: d.title,
  start: d.allDay ? d.start.slice(0, 10) : d.start,
  end: d.allDay ? d.end.slice(0, 10) : d.end,
  allDay: d.allDay,
  tz: d.tz,
  rrule: d.rrule,
  location: d.location,
  description: d.description,
  reminders: d.allDay ? [] : [10],
  attendees: d.attendees.map((a) => (a.userId ? { userId: a.userId } : { email: a.email, name: a.name })),
});

// ── 3. Ask Calendar (tool use, drafts only) ───────────────────────────────

export type Action =
  | { kind: "create"; summary: string; input: EventInput }
  | { kind: "update"; summary: string; eventId: string; occ: string | null; scope: "this" | "all"; input: EventInput }
  | { kind: "delete"; summary: string; eventId: string; occ: string | null; scope: "this" | "all" };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_events",
    description: "List the person's events (their calendars, team calendars and invitations) between two local dates, inclusive. Returns ids, occurrence starts, times, guests and whether they can edit it.",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } }, required: ["from", "to"], additionalProperties: false },
    strict: true,
  },
  {
    name: "find_free_time",
    description: "Find the best free slots for the person and optional workspace colleagues (by name) between two local dates, inside everyone's working hours, never over lunch or meetings. Returns up to 5 slots with reasons.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        duration_minutes: { type: "integer" },
        attendee_names: { type: "array", items: { type: "string" } },
        day_part: { type: "string", enum: ["morning", "afternoon", "any"] },
      },
      required: ["from", "to", "duration_minutes", "attendee_names", "day_part"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "create_event",
    description: "Prepare a new event as a DRAFT for the person to confirm. Nothing is saved until they click Confirm. Use only times the person asked for or that find_free_time returned, and only people they named.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        start_time: { type: "string", description: "HH:MM 24-hour, local" },
        duration_minutes: { type: "integer" },
        attendee_names: { type: "array", items: { type: "string" } },
        location: { type: "string" },
      },
      required: ["title", "date", "start_time", "duration_minutes", "attendee_names", "location"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "update_event",
    description: "Prepare a change to an existing event (move, resize, rename) as a DRAFT for the person to confirm. event_id and occurrence_start come from list_events. For a repeating event, scope 'this' changes one occurrence, 'all' the series.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        occurrence_start: { type: ["string", "null"], description: "The occ value from list_events for repeating events, else null" },
        scope: { type: "string", enum: ["this", "all"] },
        new_date: { type: ["string", "null"], description: "YYYY-MM-DD or null to keep" },
        new_start_time: { type: ["string", "null"], description: "HH:MM or null to keep" },
        new_duration_minutes: { type: ["integer", "null"] },
        new_title: { type: ["string", "null"] },
      },
      required: ["event_id", "occurrence_start", "scope", "new_date", "new_start_time", "new_duration_minutes", "new_title"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "delete_event",
    description: "Prepare cancelling an event as a DRAFT for the person to confirm. For a repeating event, scope 'this' cancels one occurrence, 'all' the series.",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "string" }, occurrence_start: { type: ["string", "null"] }, scope: { type: "string", enum: ["this", "all"] } },
      required: ["event_id", "occurrence_start", "scope"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "search_company_knowledge",
    description: "Search the company's knowledge base (SOPs, policies, processes, holidays, office hours, travel rules, products, prices, customers). Use it for questions about how the company works, e.g. which days are holidays or what a meeting should cover. Returns numbered passages with article titles; cite them.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
];

export type ChatTurn = { role: "user" | "assistant"; text: string };

export async function askCalendar(me: Me, history: ChatTurn[], question: string) {
  ensureKey();
  const q = question.trim().slice(0, 1000);
  if (!q) throw new HttpError(400, "Ask something about your calendar.");
  // Knowledge first: the question is looked up before the model sees it.
  const [ctx, company] = await Promise.all([timeContext(me), consultKnowledge(me, q, { context: history.filter((h) => h.role === "user").slice(-1).map((h) => h.text.slice(0, 200)).join(" "), tool: true })]);
  const tz = ctx.tz;
  const dir = await directory(me);
  const actions: (Action & { id: string })[] = [];
  const looked: { kind: string; detail: string }[] = company.context ? [{ kind: "knowledge", detail: company.hits.length ? `checked first: ${company.hits.length} found` : "checked first: nothing matched" }] : [];
  const system = `You are the calendar assistant inside the person's business suite. ${ctx.text}
You can read their calendar and find free time with tools. You cannot change anything yourself: create_event, update_event and delete_event only prepare drafts that the person confirms with a button. Say "I've prepared…" for those, never "done".
For company rules and facts (holidays, policies, processes), use search_company_knowledge and cite the article; never guess them.
Rules: use only event ids from list_events. Never invent people, events or times: use times the person said or that find_free_time returned ("tomorrow morning" means look in tomorrow's morning with find_free_time). If several events match, ask which one. Keep answers short and concrete: times like "3:00 pm", day names, plain sentences or brief bullet points. Today's date matters: resolve relative dates from the list above.${company.context ? `\n\n${company.context}` : ""}`;
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-10).filter((h) => h.text.trim()).map((h) => ({ role: h.role, content: h.text.slice(0, 4000) })),
    { role: "user", content: q },
  ];
  // The API wants the conversation to start with the person.
  while (messages.length && messages[0].role !== "user") messages.shift();

  const run = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (name === "list_events") {
      const from = String(input.from), to = String(input.to);
      if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to)) return "Error: dates must be YYYY-MM-DD.";
      const evs = await occurrences(me, dayWindow(from, tz).start, dayWindow(to > from ? to : from, tz).end);
      looked.push({ kind: "list", detail: `${from} to ${to}` });
      if (!evs.length) return "No events.";
      return JSON.stringify(
        evs.slice(0, 80).map((o) => ({
          id: o.id,
          occ: o.occ,
          title: o.title,
          when: o.allDay ? `${localDate(o.start, "UTC")} all day` : `${fmtWhen(o.start, tz)} - ${fmtTime(o.end, tz)}`,
          repeats: !!o.rrule,
          guests: o.attendees.map((a) => a.name || a.email),
          myReply: o.myResponse,
          canEdit: o.canEdit,
          link: o.conferenceUrl ? "video" : undefined,
        })),
      );
    }
    if (name === "search_company_knowledge") {
      const k = await consultKnowledge(me, String(input.query ?? ""), { tool: true });
      looked.push({ kind: "knowledge", detail: String(input.query ?? "").slice(0, 60) });
      return k.hits.length ? k.context : "Nothing in the company knowledge base covers that.";
    }
    if (name === "find_free_time") {
      const m = matchPeople((input.attendee_names as string[]) ?? [], dir, me.userId);
      if (m.unmatched.length || m.ambiguous.length) return `Error: not found in the workspace: ${[...m.unmatched, ...m.ambiguous.map((a) => `${a.mention} (could be ${a.options.map((o) => o.name).join(" or ")})`)].join(", ")}. Ask the person.`;
      const slots = await findSlots(me, m.matched.map((x) => x.id), String(input.from), String(input.to), Number(input.duration_minutes) || 30, { limit: 5, dayPart: input.day_part === "any" ? null : (input.day_part as "morning" | "afternoon") });
      looked.push({ kind: "free", detail: `${input.duration_minutes} min${m.matched.length ? ` with ${m.matched.map((x) => x.name).join(", ")}` : ""}` });
      return slots.length ? JSON.stringify(slots.map((s) => ({ date: localDate(s.start, tz), start_time: localHM(s.start, tz), end_time: localHM(s.end, tz), reason: s.reason }))) : "No free time that works in that range.";
    }
    if (name === "create_event") {
      const m = matchPeople((input.attendee_names as string[]) ?? [], dir, me.userId);
      if (m.unmatched.length || m.ambiguous.length) return `Error: not found in the workspace: ${[...m.unmatched, ...m.ambiguous.map((a) => a.mention)].join(", ")}. Ask the person; don't add anyone else.`;
      const date = String(input.date), time = String(input.start_time);
      if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time)) return "Error: date YYYY-MM-DD and start_time HH:MM are required.";
      const start = at(date, time, tz);
      const end = new Date(start.getTime() + Math.max(5, Math.min(1440, Number(input.duration_minutes) || 30)) * 60_000);
      const who = [...m.matched.map((x) => ({ userId: x.id })), ...m.external.map((x) => ({ email: x.email }))];
      actions.push({
        id: `a${actions.length + 1}`,
        kind: "create",
        summary: `Create “${String(input.title)}” · ${fmtWhen(start, tz)} – ${fmtTime(end, tz)}${m.matched.length ? ` · with ${m.matched.map((x) => x.name).join(", ")}` : ""}${input.location ? ` · ${String(input.location)}` : ""}`,
        input: { title: String(input.title), start: start.toISOString(), end: end.toISOString(), tz, location: String(input.location ?? ""), attendees: who, reminders: [10] },
      });
      return "Draft prepared. The person will see it and confirm or dismiss it.";
    }
    if (name === "update_event" || name === "delete_event") {
      let ev;
      try {
        ev = await loadEvent(me, String(input.event_id));
      } catch {
        return "Error: no such event. Use an id from list_events.";
      }
      const occ = input.occurrence_start ? String(input.occurrence_start) : null;
      const scope = input.scope === "this" ? "this" : "all";
      const curStart = occ ? new Date(occ) : ev.start;
      const dur = ev.end.getTime() - ev.start.getTime();
      const when = ev.allDay ? localDate(curStart, "UTC") : fmtWhen(curStart, tz);
      const series = ev.rrule ? (scope === "this" ? " (this one only)" : " (every occurrence)") : "";
      if (name === "delete_event") {
        actions.push({ id: `a${actions.length + 1}`, kind: "delete", summary: `Cancel “${ev.title}” · ${when}${series}`, eventId: ev.id, occ: ev.rrule ? curStart.toISOString() : null, scope });
        return "Draft prepared. The person will confirm or dismiss it.";
      }
      const patch: EventInput = {};
      let ns = curStart, ne = new Date(curStart.getTime() + dur);
      if (input.new_date || input.new_start_time) {
        const d = (input.new_date as string) || localDate(curStart, tz);
        const t = (input.new_start_time as string) || localHM(curStart, tz);
        ns = at(d, t, tz);
        ne = new Date(ns.getTime() + dur);
      }
      if (input.new_duration_minutes) ne = new Date(ns.getTime() + Number(input.new_duration_minutes) * 60_000);
      if (ns.getTime() !== curStart.getTime() || ne.getTime() !== curStart.getTime() + dur) {
        patch.start = ns.toISOString();
        patch.end = ne.toISOString();
      }
      if (input.new_title) patch.title = String(input.new_title);
      if (!Object.keys(patch).length) return "Error: nothing to change.";
      actions.push({
        id: `a${actions.length + 1}`,
        kind: "update",
        summary: `${patch.start ? "Move" : "Rename"} “${ev.title}” · ${when}${patch.start ? ` → ${fmtWhen(ns, tz)} – ${fmtTime(ne, tz)}` : ""}${patch.title ? ` → “${patch.title}”` : ""}${series}`,
        eventId: ev.id,
        occ: ev.rrule ? curStart.toISOString() : null,
        scope,
        input: patch,
      });
      return "Draft prepared. The person will confirm or dismiss it.";
    }
    return `Error: unknown tool ${name}.`;
  };

  try {
    for (let turn = 0; turn < 8; turn++) {
      const r = await anthropic().messages.create({ model: SONNET, max_tokens: 4000, system, tools: TOOLS, messages, output_config: { effort: "low" } } as Anthropic.MessageCreateParamsNonStreaming);
      if (r.stop_reason === "refusal") throw new HttpError(422, "The assistant declined this request.");
      messages.push({ role: "assistant", content: r.content });
      const uses = r.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (r.stop_reason !== "tool_use" || !uses.length) return { answer: textOf(r) || (actions.length ? "Here's what I've prepared." : "I couldn't work that out."), actions, looked };
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const out = await run(u.name, (u.input ?? {}) as Record<string, unknown>).catch((e) => `Error: ${(e as Error).message}`);
        results.push({ type: "tool_result", tool_use_id: u.id, content: out, ...(out.startsWith("Error:") ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    return { answer: actions.length ? "Here's what I've prepared." : "That took too many steps. Try a simpler question.", actions, looked };
  } catch (e) {
    aiError(e);
  }
}

/** Run a confirmed action with the person's own permissions. */
export async function applyAction(me: Me, a: Action) {
  if (a.kind === "create") return { event: await createEvent(me, a.input) };
  if (a.kind === "update") return { event: await updateEvent(me, a.eventId, a.input, a.occ ? a.scope : "all", a.occ ?? undefined) };
  if (a.kind === "delete") {
    await deleteEvent(me, a.eventId, a.occ ? a.scope : "all", a.occ ?? undefined);
    return { deleted: true };
  }
  throw new HttpError(400, "Unknown action.");
}

// ── 4. One-line headline for the daily brief ──────────────────────────────

export async function briefHeadline(me: Me, b: { events: { title: string; start: string; end: string; allDay: boolean }[]; issues: { title: string }[]; tasks: { title: string; overdue: boolean }[]; focus: { start: string; end: string }[]; meetingMinutes: number }) {
  const tz = me.tz || "UTC";
  const facts = {
    meetings: b.events.filter((e) => !e.allDay).map((e) => `${fmtTime(e.start, tz)}-${fmtTime(e.end, tz)} ${e.title}`),
    allDay: b.events.filter((e) => e.allDay).map((e) => e.title),
    meetingHours: Math.round(b.meetingMinutes / 6) / 10,
    problems: b.issues.map((i) => i.title),
    tasksDue: b.tasks.map((t) => `${t.title}${t.overdue ? " (overdue)" : ""}`),
    focusWindows: b.focus.map((f) => `${fmtTime(f.start, tz)}-${fmtTime(f.end, tz)}`),
  };
  // Knowledge first: the day's meetings and tasks looked up in the company's articles.
  const company = await consultKnowledge(me, [...b.events.map((e) => e.title), ...b.tasks.map((t) => t.title)].join(" ").slice(0, 600), { cite: false });
  const r = await haikuJson<{ headline: string }>(
    "You write the one-sentence headline of a person's daily brief (max 28 words), friendly and specific, from the facts given only. Mention the most important thing first (a problem, the key meeting, or an overdue task). Never list what is empty or missing; if the day is clear, say so in a few words. No greetings.",
    JSON.stringify(facts),
    { type: "object", additionalProperties: false, required: ["headline"], properties: { headline: { type: "string" } } },
    company.context,
  );
  return r.headline.trim();
}

// ── 6. Meeting prep ───────────────────────────────────────────────────────

export async function prep(me: Me, eventId: string, occ: string | null) {
  const ev = await loadEvent(me, eventId);
  const tz = me.tz || "UTC";
  const start = occ ? new Date(occ) : ev.start;
  const guests = ev.attendees.filter((a) => a.userId !== me.userId);
  const guestIds = guests.map((a) => a.userId).filter(Boolean) as string[];
  const open = me.perms["tasks.open"]
    ? await db.task.findMany({
        where: { ws: me.ws, completedAt: null, project: { archived: false, members: { some: { userId: me.userId } } } },
        select: { id: true, title: true, assigneeId: true, due: true, status: true, projectId: true, priority: true, project: { select: { name: true } } },
        take: 500,
      })
    : [];
  const tasks = relatedTasks(ev.title, guestIds, open, start.getTime()).slice(0, 8);
  const dir = await directory(me);
  const nameOf = (id: string | null) => dir.find((p) => p.id === id)?.name ?? "Unassigned";
  let emails: { subject: string; from: string; date: string; snippet: string; href: string }[] = [];
  let mail: "ok" | "none" | "offline" = "ok";
  try {
    const r = await suiteCall<{ messages?: typeof emails; mailboxes?: number }>("/api/iotx/context", { body: { userId: me.userId, ws: me.ws, query: ev.title, emails: guests.map((g) => g.email), limit: 6 } });
    if (r.status !== 200) mail = "offline";
    else {
      emails = r.data.messages ?? [];
      if (!r.data.mailboxes) mail = "none";
    }
  } catch {
    mail = "offline";
  }
  // Knowledge first: the meeting looked up in the company's articles; the passages go to the briefing as sources.
  const kb = await consultKnowledge(me, `${ev.title} ${ev.description.slice(0, 200)}`, { context: guests.map((g) => g.name).join(" "), cite: false });
  const facts = {
    meeting: { title: ev.title, when: ev.allDay ? "all day" : fmtWhen(start, tz), description: ev.description.slice(0, 1500), location: ev.location },
    guests: guests.map((g) => ({ name: g.name || g.email, reply: g.response })),
    relatedTasks: tasks.map((t) => ({ title: t.title, owner: nameOf(t.assigneeId), status: t.status, due: t.due?.toISOString().slice(0, 10) ?? null })),
    recentEmails: emails.map((m) => ({ subject: m.subject, from: m.from, date: m.date.slice(0, 10), snippet: m.snippet.slice(0, 240) })),
  };
  let bullets: string[] = [];
  let aiError: string | null = null;
  try {
    const r = await haikuJson<{ bullets: string[] }>(
      "You prepare a busy person for a meeting. From the facts only, write exactly 3 short bullets (max 22 words each): the likely purpose / what to decide, the open work, emails or company knowledge (SOPs, policies, prices) worth knowing (name them), and one concrete thing to prepare or ask. If facts are thin, say what is missing (for example, no agenda) instead of inventing.",
      JSON.stringify(facts),
      { type: "object", additionalProperties: false, required: ["bullets"], properties: { bullets: { type: "array", items: { type: "string" } } } },
      kb.context,
    );
    bullets = (r.bullets ?? []).map((b) => b.trim()).filter(Boolean).slice(0, 3);
  } catch (e) {
    aiError = (e as Error).message;
  }
  return {
    event: { id: ev.id, title: ev.title, start: start.toISOString(), allDay: ev.allDay },
    attendees: guests.map((g) => ({ name: g.name || g.email, email: g.email, response: g.response, internal: !!g.userId })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: nameOf(t.assigneeId), due: t.due?.toISOString().slice(0, 10) ?? null, href: `/workspace/tasks?project=${t.projectId}&task=${t.id}` })),
    emails,
    mail,
    knowledge: kb.hits.map((h) => ({ title: h.title, section: h.heading, href: h.platform ? null : `/knowledge?doc=${h.docId}` })),
    bullets,
    aiError,
  };
}

// ── 7. Plan my day ────────────────────────────────────────────────────────

export async function planDay(me: Me, date: string) {
  const tz = me.tz || "UTC";
  const hours = (await hoursOf([me.userId])).get(me.userId)?.hours ?? DEFAULT_HOURS;
  const w = dayWindow(date, tz);
  const evs = (await occurrences(me, w.start, w.end)).filter((o) => !o.allDay && o.myResponse !== "no");
  const isToday = localDate(Date.now(), tz) === date;
  const after = isToday ? Math.ceil((Date.now() + 10 * 60_000) / (15 * 60_000)) * 15 * 60_000 : 0;
  const buf = hours.buffer * 60_000;
  const free = freeWindows(date, tz, hours, evs.map((o) => ({ start: Date.parse(o.start) - buf, end: Date.parse(o.end) + buf })), after);
  const horizon = new Date(new Date(`${date}T00:00:00Z`).getTime() + 3 * 86_400_000);
  const tasks = me.perms["tasks.open"]
    ? await db.task.findMany({
        where: { ws: me.ws, assigneeId: me.userId, completedAt: null, parentId: null, project: { archived: false, members: { some: { userId: me.userId } } }, OR: [{ due: { lte: horizon } }, { priority: { gte: 2 } }] },
        include: { project: { select: { name: true } } },
        orderBy: [{ due: "asc" }, { priority: "desc" }],
        take: 15,
      })
    : [];
  if (!tasks.length) return { blocks: [], unplaced: [], free: free.length, note: "No open tasks due soon are assigned to you." };
  if (!free.length) return { blocks: [], unplaced: tasks.map((t) => ({ id: t.id, title: t.title })), free: 0, note: "No free time left in your working day." };
  const dayStart = new Date(`${date}T00:00:00Z`);
  const list = tasks.map((t) => ({ id: t.id, title: t.title, project: t.project.name, priority: ["low", "normal", "high", "urgent"][t.priority] ?? "normal", due: t.due?.toISOString().slice(0, 10) ?? null, overdue: !!t.due && t.due < dayStart, status: t.status, checklist: Array.isArray(t.checklist) ? (t.checklist as unknown[]).length : 0 }));
  const freeText = free.map((f) => `${localHM(f.start, tz)}-${localHM(f.end, tz)}`).join(", ");
  // Knowledge first: the tasks looked up in the company's articles (priorities, deadlines, processes).
  const company = await consultKnowledge(me, tasks.map((t) => t.title).join(" ").slice(0, 600), { cite: false });
  let plan: { taskId: string; minutes: number; reason: string }[] = [];
  let source: "ai" | "rules" = "ai";
  try {
    ensureKey();
    const r = await anthropic().messages.create({
      model: SONNET,
      max_tokens: 2000,
      system: `You plan focus time for one work day. Free windows today: ${freeText}. Choose which tasks to work on today and in what order (most important first: overdue, due today, urgent, high priority). Estimate realistic minutes per task (15-120, in steps of 15). Use only task ids given. Fit within the free time; leave out what doesn't fit. reason: max 10 words.${company.context ? `\n\n${company.context}` : ""}`,
      messages: [{ role: "user", content: JSON.stringify(list) }],
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: { type: "object", additionalProperties: false, required: ["plan"], properties: { plan: { type: "array", items: { type: "object", additionalProperties: false, required: ["taskId", "minutes", "reason"], properties: { taskId: { type: "string" }, minutes: { type: "integer" }, reason: { type: "string" } } } } } },
        },
      },
    } as Anthropic.MessageCreateParamsNonStreaming);
    plan = (JSON.parse(textOf(r)) as { plan: typeof plan }).plan.filter((p) => tasks.some((t) => t.id === p.taskId));
    if (!plan.length) throw new Error("empty plan");
  } catch {
    source = "rules";
    plan = list.map((t) => ({ taskId: t.id, minutes: t.priority === "urgent" ? 90 : t.priority === "high" ? 60 : 45, reason: t.overdue ? "Overdue" : t.due === date ? "Due today" : `${t.priority[0].toUpperCase()}${t.priority.slice(1)} priority` }));
  }
  const slots = free.map((f) => ({ ...f }));
  const blocks: { taskId: string; title: string; project: string; start: string; end: string; reason: string }[] = [];
  const unplaced: { id: string; title: string }[] = [];
  for (const p of plan) {
    const t = list.find((x) => x.id === p.taskId)!;
    if (blocks.some((b) => b.taskId === t.id)) continue;
    const ms = Math.max(15, Math.min(180, Math.round((p.minutes || 45) / 15) * 15)) * 60_000;
    const s = slots.find((x) => x.end - x.start >= ms);
    if (!s) {
      unplaced.push({ id: t.id, title: t.title });
      continue;
    }
    blocks.push({ taskId: t.id, title: t.title, project: t.project, start: new Date(s.start).toISOString(), end: new Date(s.start + ms).toISOString(), reason: p.reason });
    s.start += ms + 5 * 60_000;
  }
  return { blocks, unplaced, free: free.length, source };
}

export function focusInput(b: { taskId: string; title: string; start: string; end: string }, projectId?: string): EventInput {
  return {
    title: `Focus: ${b.title}`.slice(0, 300),
    start: b.start,
    end: b.end,
    description: `Focus time for a task.\n${projectId ? `/workspace/tasks?project=${projectId}&task=${b.taskId}` : `/workspace/tasks?task=${b.taskId}`}`,
    color: "#16a34a",
    reminders: [5],
  };
}
