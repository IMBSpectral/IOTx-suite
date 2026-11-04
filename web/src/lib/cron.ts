/**
 * Schedules for automations: 5-field cron ("minute hour day-of-month month
 * day-of-week") evaluated in an IANA time zone, or "once:<ISO time>" for a
 * one-off. Supports *, lists, ranges and steps (e.g. "*\/15", "1-5", "0,30").
 * Day-of-week is 0-6 with Sunday as 0 (7 is accepted as Sunday too).
 */

type Field = Set<number>;
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; domAny: boolean; dowAny: boolean };

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(src: string, [min, max]: [number, number]): Field {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) [lo, hi] = range.split("-").map(Number) as [number, number];
    else {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`"${part}" is out of range ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule needs 5 fields: minute hour day month weekday.");
  const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, RANGES[i]));
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of an instant in a time zone. */
function partsIn(date: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, dow };
}

export function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c: Cron, p: { day: number; dow: number }) {
  // Standard cron: when both day fields are restricted, either may match.
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return c.dow.has(p.dow);
  if (c.dowAny) return c.dom.has(p.day);
  return c.dom.has(p.day) || c.dow.has(p.dow);
}

/**
 * The first matching minute strictly after `after`, or null when there is
 * none within a year (e.g. February 30th). Whole hours and days that can't
 * match are skipped, so this stays fast.
 */
export function nextRun(schedule: string, tz: string, after = new Date()): Date | null {
  if (schedule.startsWith("once:")) {
    const at = new Date(schedule.slice(5));
    if (Number.isNaN(at.getTime())) throw new Error("Bad one-off time");
    return at > after ? at : null;
  }
  const c = parseCron(schedule);
  let t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const limit = after.getTime() + 366 * 86_400_000;
  while (t.getTime() <= limit) {
    const p = partsIn(t, tz);
    if (!c.month.has(p.month) || !dayMatches(c, p)) {
      // Jump to the next local midnight (approximately; re-checked next loop).
      t = new Date(t.getTime() + ((23 - p.hour) * 60 + (60 - p.minute)) * 60_000);
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t = new Date(t.getTime() + (60 - p.minute) * 60_000);
      continue;
    }
    if (c.minute.has(p.minute)) return t;
    t = new Date(t.getTime() + 60_000);
  }
  return null;
}

/** Plain-language description for the list, e.g. "Weekdays at 09:00". */
export function describeSchedule(schedule: string, tz: string) {
  if (schedule.startsWith("once:")) return `Once, ${new Date(schedule.slice(5)).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}`;
  const parts = schedule.trim().split(/\s+/);
  const [m, h, dom, mon, dow] = parts;
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : null;
  if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "Every hour";
  if (time && dom === "*" && mon === "*" && dow === "*") return `Daily at ${time}`;
  if (time && dom === "*" && mon === "*" && dow === "1-5") return `Weekdays at ${time}`;
  if (time && dom === "*" && mon === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return `${dow.split(",").map((d) => names[+d]).join(", ")} at ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `Monthly on day ${dom} at ${time}`;
  return `Cron: ${schedule}`;
}
