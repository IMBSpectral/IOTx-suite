import { dayNum, partsIn, zonedToUtc } from "./time";

/**
 * A small RRULE expander: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL,
 * BYDAY (MO..SU, and 1MO / -1FR for monthly), BYMONTHDAY, BYMONTH, COUNT and
 * UNTIL. Occurrences are computed on the wall clock of the event's zone, so a
 * 9:00 weekly meeting stays at 9:00 across daylight-saving changes.
 */

export type Rule = { freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number; byday: { wd: number; n: number }[]; bymonthday: number[]; bymonth: number[]; count?: number; until?: Date };

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function parseRule(raw: string): Rule | null {
  const o: Record<string, string> = {};
  for (const part of raw.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) o[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = o.FREQ as Rule["freq"];
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const byday = (o.BYDAY ? o.BYDAY.split(",") : [])
    .map((s) => {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s);
      return m ? { wd: DAYS.indexOf(m[2]), n: m[1] ? Number(m[1]) : 0 } : null;
    })
    .filter((x): x is { wd: number; n: number } => !!x);
  let until: Date | undefined;
  if (o.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(o.UNTIL);
    if (m) until = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59));
  }
  return {
    freq,
    interval: Math.max(1, Number(o.INTERVAL ?? 1) || 1),
    byday,
    bymonthday: o.BYMONTHDAY ? o.BYMONTHDAY.split(",").map(Number).filter(Boolean) : [],
    bymonth: o.BYMONTH ? o.BYMONTH.split(",").map(Number).filter(Boolean) : [],
    count: o.COUNT ? Number(o.COUNT) : undefined,
    until,
  };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Occurrence starts of a series overlapping [from, to). */
export function expand(
  ev: { start: Date; end: Date; allDay: boolean; tz: string; rrule: string | null; exdates: string[] },
  from: Date,
  to: Date,
  max = 1000,
): Date[] {
  const dur = ev.end.getTime() - ev.start.getTime();
  if (!ev.rrule) return ev.end > from && ev.start < to ? [ev.start] : [];
  const rule = parseRule(ev.rrule);
  if (!rule) return ev.end > from && ev.start < to ? [ev.start] : [];
  const tz = ev.allDay ? "UTC" : ev.tz;
  const s0 = partsIn(ev.start, tz);
  const n0 = dayNum(s0.y, s0.m, s0.d);
  // Monday-based week index so WEEKLY;INTERVAL=2 groups Mon..Sun.
  const week = (n: number) => Math.floor((n - 4 + 7 * 1e6) / 7); // 1970-01-05 was a Monday (day 4)
  const w0 = week(n0);
  const ex = new Set(ev.exdates.map((x) => new Date(x).getTime()));
  const toParts = partsIn(to, tz);
  const nEnd = Math.min(dayNum(toParts.y, toParts.m, toParts.d) + 1, n0 + 366 * 30);
  const out: Date[] = [];
  let count = 0;
  for (let n = n0; n <= nEnd; n++) {
    const dt = new Date(n * 86_400_000);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), wd = dt.getUTCDay();
    let ok = false;
    switch (rule.freq) {
      case "DAILY":
        ok = (n - n0) % rule.interval === 0 && (!rule.byday.length || rule.byday.some((b) => b.wd === wd));
        break;
      case "WEEKLY": {
        const days = rule.byday.length ? rule.byday.map((b) => b.wd) : [s0.wd];
        ok = (week(n) - w0) % rule.interval === 0 && days.includes(wd);
        break;
      }
      case "MONTHLY": {
        const months = (y - s0.y) * 12 + (m - s0.m);
        if (months % rule.interval !== 0) break;
        if (rule.byday.length) {
          const dim = daysInMonth(y, m);
          ok = rule.byday.some((b) => b.wd === wd && (b.n === 0 || (b.n > 0 ? Math.ceil(d / 7) === b.n : Math.ceil((dim - d + 1) / 7) === -b.n)));
        } else if (rule.bymonthday.length) {
          const dim = daysInMonth(y, m);
          ok = rule.bymonthday.some((x) => (x > 0 ? x === d : dim + x + 1 === d));
        } else ok = d === s0.d;
        break;
      }
      case "YEARLY": {
        if ((y - s0.y) % rule.interval !== 0) break;
        const months = rule.bymonth.length ? rule.bymonth : [s0.m];
        const mdays = rule.bymonthday.length ? rule.bymonthday : [s0.d];
        ok = months.includes(m) && mdays.includes(d);
        break;
      }
    }
    if (!ok) continue;
    const start = ev.allDay ? new Date(Date.UTC(y, m - 1, d)) : zonedToUtc(y, m, d, s0.h, s0.mi, tz);
    if (rule.until && start > rule.until) break;
    count++;
    if (rule.count && count > rule.count) break;
    if (ex.has(start.getTime())) continue;
    if (start.getTime() + dur > from.getTime() && start < to) {
      out.push(start);
      if (out.length >= max) break;
    }
    if (start >= to) break;
  }
  return out;
}

/** A readable summary ("Weekly on Mon, Wed"). */
export function describeRule(raw: string | null) {
  if (!raw) return "";
  const r = parseRule(raw);
  if (!r) return "Repeats";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const every = r.interval > 1 ? `Every ${r.interval} ` : "";
  switch (r.freq) {
    case "DAILY":
      return r.interval > 1 ? `${every}days` : "Daily";
    case "WEEKLY":
      return `${r.interval > 1 ? `${every}weeks` : "Weekly"}${r.byday.length ? ` on ${r.byday.map((b) => names[b.wd]).join(", ")}` : ""}`;
    case "MONTHLY":
      return r.interval > 1 ? `${every}months` : "Monthly";
    case "YEARLY":
      return "Yearly";
  }
}
