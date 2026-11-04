import { DAY_CODES, fromKey } from "./types";

/** A repeat rule as the editor shows it (Google Calendar's "Custom recurrence"). */
export type Repeat = {
  freq: "" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: string[];
  /** Monthly: on the same date, or on the nth weekday (e.g. 2nd Tuesday, last Friday). */
  monthMode: "date" | "nth";
  ends: "never" | "until" | "count";
  until: string;
  count: number;
};

const NAMES: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
const ORD = ["", "first", "second", "third", "fourth", "fifth"];

/** Which "nth weekday" a date is: 1..4, or -1 when it is the last one in its month. */
export function nthOf(date: string) {
  const d = fromKey(date);
  const n = Math.ceil(d.getDate() / 7);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() < 7;
  return { n: n >= 5 || (last && n === 4) ? -1 : n, code: DAY_CODES[d.getDay()] };
}

export function blankRepeat(date: string): Repeat {
  return { freq: "", interval: 1, byday: [DAY_CODES[fromKey(date).getDay()]], monthMode: "date", ends: "never", until: "", count: 10 };
}

export function parseRepeat(rrule: string | null, date: string): Repeat {
  const r = blankRepeat(date);
  if (!rrule) return r;
  const o = Object.fromEntries(rrule.replace(/^RRULE:/, "").split(";").map((p) => p.split("=") as [string, string]));
  r.freq = (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(o.FREQ) ? o.FREQ : "") as Repeat["freq"];
  r.interval = Math.max(1, Number(o.INTERVAL ?? 1) || 1);
  if (o.BYDAY) {
    if (r.freq === "MONTHLY" && /^-?\d/.test(o.BYDAY)) r.monthMode = "nth";
    else r.byday = o.BYDAY.split(",").map((x: string) => x.replace(/^[-\d]+/, ""));
  }
  if (o.COUNT) {
    r.ends = "count";
    r.count = Number(o.COUNT) || 10;
  } else if (o.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(o.UNTIL);
    if (m) {
      r.ends = "until";
      r.until = `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return r;
}

export function buildRepeat(r: Repeat, date: string): string | null {
  if (!r.freq) return null;
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === "WEEKLY") parts.push(`BYDAY=${(r.byday.length ? r.byday : [DAY_CODES[fromKey(date).getDay()]]).join(",")}`);
  if (r.freq === "MONTHLY" && r.monthMode === "nth") {
    const { n, code } = nthOf(date);
    parts.push(`BYDAY=${n}${code}`);
  }
  if (r.ends === "count") parts.push(`COUNT=${Math.max(1, Math.min(999, Math.round(r.count) || 1))}`);
  if (r.ends === "until" && r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}T235959Z`);
  return parts.join(";");
}

/** "Every 2 weeks on Monday, Wednesday, until 30 Nov" */
export function describeRepeat(rrule: string | null, date?: string) {
  if (!rrule) return "Does not repeat";
  const o = Object.fromEntries(rrule.replace(/^RRULE:/, "").split(";").map((p) => p.split("=") as [string, string]));
  const iv = Math.max(1, Number(o.INTERVAL ?? 1) || 1);
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[o.FREQ as string] ?? "time";
  let s = iv > 1 ? `Every ${iv} ${unit}s` : { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Annually" }[o.FREQ as string] ?? "Repeats";
  if (o.BYDAY) {
    const days = String(o.BYDAY).split(",");
    const nth = /^(-?\d)([A-Z]{2})$/.exec(days[0]);
    if (nth) s += ` on the ${nth[1] === "-1" ? "last" : ORD[Number(nth[1])] ?? nth[1]} ${NAMES[nth[2]]}`;
    else if (days.join(",") === "MO,TU,WE,TH,FR") s += " on weekdays";
    else s += ` on ${days.map((d) => NAMES[d] ?? d).join(", ")}`;
  } else if (o.FREQ === "MONTHLY" && date) s += ` on day ${fromKey(date).getDate()}`;
  if (o.COUNT) s += `, ${o.COUNT} times`;
  else if (o.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(o.UNTIL));
    if (m) s += `, until ${new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`;
  }
  return s;
}

/** The quick choices Google offers for a start date, plus "Custom…". */
export function presets(date: string): { label: string; rule: string | null }[] {
  const d = fromKey(date);
  const code = DAY_CODES[d.getDay()];
  const { n } = nthOf(date);
  const dayName = NAMES[code];
  return [
    { label: "Does not repeat", rule: null },
    { label: "Daily", rule: "FREQ=DAILY" },
    { label: `Weekly on ${dayName}`, rule: `FREQ=WEEKLY;BYDAY=${code}` },
    { label: `Monthly on the ${n === -1 ? "last" : ORD[n]} ${dayName}`, rule: `FREQ=MONTHLY;BYDAY=${n}${code}` },
    { label: `Annually on ${d.toLocaleDateString([], { month: "long", day: "numeric" })}`, rule: "FREQ=YEARLY" },
    { label: "Every weekday (Monday to Friday)", rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  ];
}
