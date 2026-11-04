import { route } from "@/lib/route";
import { forbidden, serviceKeyOk } from "@/lib/iotx/service-key";
import { sendPlatformEmail } from "@/lib/platform-email";

/**
 * Email from an IOTx app that runs as its own process (Calendar invitations,
 * replies and booking confirmations from apps/workspace). Server to server
 * (x-iotx-key); goes out through the platform's mail sender.
 *
 *   POST { to, subject, text, html?, ics?: { method, content }, fromName? } -> { status }
 */
// "@localhost" too: local accounts use it, and such mail only ever lands in the outbox.
const EMAIL = /^[^\s@<>]+@([^\s@<>]+\.[^\s@<>]+|localhost)$/;

async function POST_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const b = (await req.json().catch(() => ({}))) as { to?: string; subject?: string; text?: string; html?: string; ics?: { method?: string; content?: string }; fromName?: string };
  const to = String(b.to ?? "").trim();
  if (!EMAIL.test(to)) return Response.json({ error: "A valid to address is required" }, { status: 400 });
  if (!b.subject?.trim() || typeof b.text !== "string") return Response.json({ error: "subject and text are required" }, { status: 400 });
  const method = String(b.ics?.method ?? "").toUpperCase();
  const ics = b.ics?.content && ["REQUEST", "CANCEL", "REPLY", "PUBLISH"].includes(method) && b.ics.content.length < 200_000 ? { method, content: b.ics.content } : undefined;
  const status = await sendPlatformEmail({
    to,
    subject: b.subject.trim().slice(0, 300),
    text: b.text.slice(0, 50_000),
    html: typeof b.html === "string" ? b.html.slice(0, 200_000) : undefined,
    icalEvent: ics,
    fromName: typeof b.fromName === "string" ? b.fromName.trim().slice(0, 80) || undefined : undefined,
  });
  return Response.json({ status });
}

export const POST = route(POST_);
