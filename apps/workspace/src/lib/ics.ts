import { zonedToUtc } from "./time";

/**
 * iCalendar (RFC 5545), the parts calendars actually exchange: VEVENTs with
 * start/end (UTC, floating, TZID or all-day), summary, description, location,
 * RRULE, EXDATE, RECURRENCE-ID, attendees and organizer. Used for import,
 * export, subscription feeds and email invitations.
 */

export type IcsEvent = {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  tz: string;
  rrule: string | null;
  exdates: string[];
  recurrenceId: Date | null;
  url: string | null;
  status: string;
  attendees: { email: string; name: string; partstat: string }[];
  organizer: string | null;
  sequence: number;
};

const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, "");
const unescape = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

type Prop = { name: string; params: Record<string, string>; value: string };
function parseLine(line: string): Prop | null {
  // NAME;PARAM=a;PARAM="b:c":value — split at the first colon outside quotes.
  let q = false;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ":" && !q) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const [k, ...v] = p.split("=");
    params[k.toUpperCase()] = v.join("=").replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(i + 1) };
}

/** A date-time value: 20261031T090000Z (UTC), 20261031T090000 with TZID (zoned) or floating, or 20261031 (all-day). */
function parseDate(p: Prop, fallbackTz: string): { at: Date; allDay: boolean; tz: string } | null {
  const v = p.value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || p.params.VALUE === "DATE") {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), allDay: true, tz: "UTC" };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!t) return null;
  if (t[7] === "Z") return { at: new Date(Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6])), allDay: false, tz: p.params.TZID ?? fallbackTz };
  const tz = p.params.TZID && isZone(p.params.TZID) ? p.params.TZID : fallbackTz;
  return { at: zonedToUtc(+t[1], +t[2], +t[3], +t[4], +t[5], tz), allDay: false, tz };
}

function isZone(z: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

/** Parse the VEVENTs of a calendar file. `tz` is used for floating times. */
export function parseIcs(text: string, tz = "UTC"): IcsEvent[] {
  const lines = unfold(text).split(/\r?\n/);
  const out: IcsEvent[] = [];
  const calTz = /X-WR-TIMEZONE:(.+)/.exec(text)?.[1]?.trim();
  const floatTz = calTz && isZone(calTz) ? calTz : tz;
  let cur: Prop[] | null = null;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "BEGIN:VEVENT") {
      cur = [];
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:") && line !== "END:VEVENT") depth--;
    else if (line === "END:VEVENT") {
      const ev = toEvent(cur, floatTz);
      if (ev) out.push(ev);
      cur = null;
      continue;
    }
    if (depth > 0) continue; // VALARM etc.
    const p = parseLine(line);
    if (p) cur.push(p);
  }
  return out;
}

function toEvent(props: Prop[], tz: string): IcsEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const s = get("DTSTART") ? parseDate(get("DTSTART")!, tz) : null;
  if (!s) return null;
  let end: Date;
  const e = get("DTEND") ? parseDate(get("DTEND")!, tz) : null;
  if (e) end = e.at;
  else if (get("DURATION")) end = new Date(s.at.getTime() + durationMs(get("DURATION")!.value));
  else end = new Date(s.at.getTime() + (s.allDay ? 86_400_000 : 3_600_000));
  if (end <= s.at) end = new Date(s.at.getTime() + (s.allDay ? 86_400_000 : 1_800_000));
  const exdates: string[] = [];
  for (const p of props.filter((x) => x.name === "EXDATE"))
    for (const v of p.value.split(",")) {
      const d = parseDate({ ...p, value: v }, tz);
      if (d) exdates.push(d.at.toISOString());
    }
  const rid = get("RECURRENCE-ID") ? parseDate(get("RECURRENCE-ID")!, tz) : null;
  const mail = (v: string) => v.replace(/^mailto:/i, "").trim().toLowerCase();
  return {
    uid: get("UID")?.value.trim() || `${s.at.getTime()}-${Math.random().toString(36).slice(2)}`,
    summary: unescape(get("SUMMARY")?.value ?? "").slice(0, 300) || "(No title)",
    description: unescape(get("DESCRIPTION")?.value ?? "").slice(0, 8000),
    location: unescape(get("LOCATION")?.value ?? "").slice(0, 500),
    start: s.at,
    end,
    allDay: s.allDay,
    tz: s.tz,
    rrule: get("RRULE")?.value.trim().toUpperCase() ?? null,
    exdates,
    recurrenceId: rid?.at ?? null,
    url: get("URL")?.value ?? null,
    status: (get("STATUS")?.value ?? "CONFIRMED").toUpperCase(),
    attendees: props.filter((p) => p.name === "ATTENDEE").map((p) => ({ email: mail(p.value), name: p.params.CN ?? "", partstat: (p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase() })),
    organizer: get("ORGANIZER") ? mail(get("ORGANIZER")!.value) : null,
    sequence: Number(get("SEQUENCE")?.value ?? 0) || 0,
  };
}

function durationMs(v: string) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 3_600_000;
  return (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60_000 + +(m[6] ?? 0) * 1000;
}

// ── Writing ────────────────────────────────────────────────────────────────

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
/** Lines longer than 75 octets are folded. */
const fold = (line: string) => {
  const out: string[] = [];
  let s = line;
  while (Buffer.byteLength(s) > 74) {
    let n = 74;
    while (Buffer.byteLength(s.slice(0, n)) > 74) n--;
    out.push(s.slice(0, n));
    s = ` ${s.slice(n)}`;
  }
  out.push(s);
  return out.join("\r\n");
};

export type IcsOut = {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  url?: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule?: string | null;
  exdates?: string[];
  recurrenceId?: Date | null;
  organizer?: { email: string; name: string } | null;
  attendees?: { email: string; name: string; response: string }[];
  sequence?: number;
  status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
  transparent?: boolean;
  updated?: Date;
};

const PART: Record<string, string> = { yes: "ACCEPTED", no: "DECLINED", maybe: "TENTATIVE", needs: "NEEDS-ACTION" };

export function eventLines(e: IcsOut) {
  const L = [
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${utc(e.updated ?? new Date())}`,
    e.allDay ? `DTSTART;VALUE=DATE:${day(e.start)}` : `DTSTART:${utc(e.start)}`,
    e.allDay ? `DTEND;VALUE=DATE:${day(e.end)}` : `DTEND:${utc(e.end)}`,
    `SUMMARY:${esc(e.title)}`,
    ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    ...(e.rrule ? [`RRULE:${e.rrule}`] : []),
    ...(e.exdates ?? []).map((x) => (e.allDay ? `EXDATE;VALUE=DATE:${day(new Date(x))}` : `EXDATE:${utc(new Date(x))}`)),
    ...(e.recurrenceId ? [e.allDay ? `RECURRENCE-ID;VALUE=DATE:${day(e.recurrenceId)}` : `RECURRENCE-ID:${utc(e.recurrenceId)}`] : []),
    ...(e.organizer ? [`ORGANIZER;CN=${JSON.stringify(e.organizer.name || e.organizer.email)}:mailto:${e.organizer.email}`] : []),
    ...(e.attendees ?? []).map((a) => `ATTENDEE;CN=${JSON.stringify(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=${PART[a.response] ?? "NEEDS-ACTION"};RSVP=TRUE:mailto:${a.email}`),
    `SEQUENCE:${e.sequence ?? 0}`,
    `STATUS:${e.status ?? "CONFIRMED"}`,
    `TRANSP:${e.transparent ? "TRANSPARENT" : "OPAQUE"}`,
    "END:VEVENT",
  ];
  return L;
}

/** A whole calendar file. method: PUBLISH for feeds and exports, REQUEST / CANCEL / REPLY for email. */
export function buildIcs(events: IcsOut[], opts: { name?: string; method?: string } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//IOTx Suite//Calendar//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.method ?? "PUBLISH"}`,
    ...(opts.name ? [`X-WR-CALNAME:${esc(opts.name)}`] : []),
    ...events.flatMap(eventLines),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
