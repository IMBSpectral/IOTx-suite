import crypto from "node:crypto";
import { reminderTick } from "@/lib/jobs";
import { body, route } from "@/lib/http";

/** POST { job: "reminders" | "recurring" | "due" }  header x-iotx-key: runs a background job now (tests and ops). */
function keyOk(given: string | null) {
  const want = process.env.IOTX_SERVICE_KEY;
  if (!want || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function POST_(req: Request) {
  if (!keyOk(req.headers.get("x-iotx-key"))) return Response.json({ error: "Forbidden" }, { status: 403 });
  const b = await body<{ job?: string; now?: string; from?: string; only?: string[] }>(req);
  if (b.job === "reminders") {
    const now = b.now ? new Date(b.now).getTime() : Date.now();
    return Response.json({ sent: await reminderTick(now, b.from ? new Date(b.from).getTime() : now - 30_000) });
  }
  if (b.job === "email-reminders") {
    const now = b.now ? new Date(b.now).getTime() : Date.now();
    return Response.json({ sent: await (await import("@/lib/cal-plus")).emailReminderTick(now, b.from ? new Date(b.from).getTime() : now - 60_000) });
  }
  if (b.job === "recurring") return Response.json({ made: await (await import("@/lib/tasks-plan")).recurringTick(b.now ? new Date(b.now) : new Date()) });
  if (b.job === "due") {
    await (await import("@/lib/tasks-plan")).dueSoonTick(b.now ? new Date(b.now) : new Date());
    return Response.json({ ok: true });
  }
  if (b.job === "meet-retention") return Response.json({ deleted: await (await import("@/lib/meet/recording")).retentionTick(b.now ? new Date(b.now) : new Date()) });
  if (b.job === "meet-integrations") return Response.json(await (await import("@/lib/meet/integrations")).integrationsTick(b.now ? new Date(b.now) : new Date(), { only: b.only }));
  // Meet across meetings (Read AI parity, helper B).
  if (b.job === "daily-read") return Response.json({ sent: await (await import("@/lib/meet/daily")).dailyTick(b.now ? new Date(b.now) : new Date()) });
  if (b.job === "flexible") return Response.json({ actions: await (await import("@/lib/meet/recommend")).flexTick(b.now ? new Date(b.now) : new Date()) });
  if (b.job === "read-optouts") return Response.json({ dropped: await (await import("@/lib/meet/read")).applyOptOuts(String((b as { meetingId?: string }).meetingId ?? "")) });
  if (b.job === "attendance") {
    const x = b as { meetingId?: string; userId?: string };
    await (await import("@/lib/meet/read")).logAttendance(String(x.meetingId ?? ""), String(x.userId ?? ""), b.now ? new Date(b.now) : new Date());
    return Response.json({ ok: true });
  }
  if (b.job === "chat") return Response.json(await (await import("@/lib/chat")).chatTick(b.now ? new Date(b.now) : new Date()));
  return Response.json({ error: "Unknown job" }, { status: 400 });
}

export const POST = route(POST_);
