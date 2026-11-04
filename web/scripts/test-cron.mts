/** Cron schedule maths, including time zones and DST. */
import { describeSchedule, nextRun, parseCron } from "../src/lib/cron";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => d?.toISOString() ?? "null";

check("hourly", iso(nextRun("0 * * * *", "UTC", at("2026-10-22T10:15:00Z"))) === "2026-10-22T11:00:00.000Z");
check("every 15 min", iso(nextRun("*/15 * * * *", "UTC", at("2026-10-22T10:15:00Z"))) === "2026-10-22T10:30:00.000Z");
check("daily 09:00 Kolkata", iso(nextRun("0 9 * * *", "Asia/Kolkata", at("2026-10-22T10:00:00Z"))) === "2026-10-23T03:30:00.000Z");
check("weekdays skip weekend", iso(nextRun("0 9 * * 1-5", "UTC", at("2026-10-23T10:00:00Z"))) === "2026-10-26T09:00:00.000Z"); // Fri -> Mon
check("specific days", iso(nextRun("30 18 * * 2,4", "UTC", at("2026-10-22T19:00:00Z"))) === "2026-10-27T18:30:00.000Z"); // Thu evening -> Tue
check("monthly day 1", iso(nextRun("0 8 1 * *", "UTC", at("2026-10-22T00:00:00Z"))) === "2026-11-01T08:00:00.000Z");
check("DST: New York 09:00 after fall back", iso(nextRun("0 9 * * *", "America/New_York", at("2026-11-01T14:00:00Z"))) === "2026-11-02T14:00:00.000Z");
check("DST: New York 09:00 before fall back", iso(nextRun("0 9 * * *", "America/New_York", at("2026-10-31T14:00:00Z"))) === "2026-11-01T14:00:00.000Z");
check("impossible date → null", nextRun("0 0 30 2 *", "UTC", at("2026-01-01T00:00:00Z")) === null);
check("one-off in future", iso(nextRun("once:2026-12-01T09:00:00Z", "UTC", at("2026-10-22T00:00:00Z"))) === "2026-12-01T09:00:00.000Z");
check("one-off in past → null", nextRun("once:2026-01-01T09:00:00Z", "UTC", at("2026-10-22T00:00:00Z")) === null);
let bad = "";
try { parseCron("61 * * * *"); } catch (e) { bad = (e as Error).message; }
check("out of range refused", /out of range/.test(bad), bad);
try { parseCron("* * *"); bad = ""; } catch (e) { bad = (e as Error).message; }
check("wrong field count refused", /5 fields/.test(bad));
check("describe weekdays", describeSchedule("0 9 * * 1-5", "UTC") === "Weekdays at 09:00");
check("describe days", describeSchedule("30 18 * * 2,4", "UTC") === "Tue, Thu at 18:30");
const t0 = Date.now(); nextRun("0 0 29 2 *", "UTC", at("2026-03-01T00:00:00Z")); // next leap day is 2028: beyond a year -> null, worst case loop
check("worst case is fast", Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
