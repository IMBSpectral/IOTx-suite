import { db } from "@/lib/db";
import { route } from "@/lib/route";
import { mailboxesFor } from "@/lib/mail/mailbox";
import { forbidden, serviceKeyOk } from "@/lib/iotx/service-key";

/**
 * POST { userId, ws?, query, emails?: string[], limit? }   header x-iotx-key
 * Server to server, for Calendar's meeting prep: the person's own mail that
 * matches a meeting (words from its title, or mail from its attendees).
 * Searches only mailboxes they can use in Mail (their own, and shared ones
 * assigned to them), never anyone else's. Returns subject, from, date and
 * snippet; never bodies.
 */
const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "meeting", "call", "sync", "review", "weekly", "daily", "team", "about", "into", "your", "our", "you", "are", "was", "will"]);

async function POST_(req: Request) {
  if (!serviceKeyOk(req)) return forbidden();
  const b = (await req.json().catch(() => ({}))) as { userId?: string; ws?: string; query?: string; emails?: unknown; limit?: number };
  if (!b.userId) return Response.json({ error: "userId is required" }, { status: 400 });
  const membership = b.ws
    ? await db.membership.findUnique({ where: { userId_workspaceId: { userId: b.userId, workspaceId: b.ws } } })
    : await db.membership.findFirst({ where: { userId: b.userId }, orderBy: { createdAt: "asc" } });
  if (!membership) return Response.json({ error: "Not a member of that workspace" }, { status: 404 });

  const terms = [...new Set(String(b.query ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);
  const emails = (Array.isArray(b.emails) ? b.emails : []).filter((e): e is string => typeof e === "string" && /^[^\s@]+@[^\s@]+$/.test(e)).map((e) => e.toLowerCase()).slice(0, 20);
  const limit = Math.max(1, Math.min(20, Number(b.limit) || 8));
  if (!terms.length && !emails.length) return Response.json({ messages: [] });

  const boxes = await mailboxesFor(b.userId, membership.workspaceId);
  if (!boxes.length) return Response.json({ messages: [], mailboxes: 0 });

  const rows = await db.mailMessage.findMany({
    where: {
      mailboxId: { in: boxes.map((m) => m.id) },
      OR: [
        ...terms.flatMap((t) => [{ subject: { contains: t, mode: "insensitive" as const } }, { snippet: { contains: t, mode: "insensitive" as const } }]),
        ...emails.map((e) => ({ fromAddr: { equals: e, mode: "insensitive" as const } })),
      ],
    },
    orderBy: { date: "desc" },
    take: 200,
    select: { id: true, mailboxId: true, folder: true, subject: true, fromAddr: true, fromName: true, date: true, snippet: true },
  });
  const score = (r: (typeof rows)[number]) => {
    const text = `${r.subject} ${r.snippet ?? ""}`.toLowerCase();
    let s = terms.filter((t) => text.includes(t)).length * 2;
    if (emails.includes(r.fromAddr.toLowerCase())) s += 3;
    return s + Math.max(0, 1 - (Date.now() - r.date.getTime()) / (60 * 86_400_000));
  };
  const seen = new Set<string>();
  const messages = rows
    .map((r) => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s)
    .filter(({ r }) => {
      const k = `${r.subject}|${r.fromAddr}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit)
    .map(({ r }) => ({
      id: r.id,
      subject: r.subject,
      from: r.fromName ? `${r.fromName} <${r.fromAddr}>` : r.fromAddr,
      date: r.date.toISOString(),
      snippet: (r.snippet ?? "").slice(0, 300),
      href: "/mail",
    }));
  return Response.json({ messages, mailboxes: boxes.length }, { headers: { "cache-control": "no-store" } });
}

export const POST = route(POST_);
