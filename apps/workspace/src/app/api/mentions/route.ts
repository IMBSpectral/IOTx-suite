import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can, requireMe, type Me } from "@/lib/auth";
import { visibleCalendars } from "@/lib/calendar";
import { route } from "@/lib/http";

/**
 * The suite's global @ picker, for the apps that live here (Tasks, Chat,
 * Calendar, Meet). Only what the person can already see.
 *   GET ?app=tasks|teamchat|calendar|meetings&q=  -> { items }  (browse when q is empty)
 *   GET ?ref=/workspace/…                         -> { title, text } of one referenced item, for the AI
 */

type Item = { id: string; label: string; sub?: string; url: string; kind: "person" | "item"; email?: string };

const channelsIn = (me: Me): Prisma.ChannelWhereInput => ({
  ws: me.ws,
  archivedAt: null,
  OR: [{ kind: "public" }, { members: { some: { userId: me.userId } } }],
});
const taskWhere = (me: Me): Prisma.TaskWhereInput => ({ ws: me.ws, project: { archived: false, members: { some: { userId: me.userId } } } });
const meetWhere = (me: Me): Prisma.MeetingWhereInput => ({
  ws: me.ws,
  OR: [{ hostId: me.userId }, { invitees: { has: me.userId } }, { participants: { some: { userId: me.userId } } }],
});

async function people(me: Me, q: string): Promise<Item[]> {
  const ms = await db.member.findMany({ where: { ws: me.ws }, select: { userId: true } });
  const users = await db.user.findMany({
    where: { id: { in: ms.map((m) => m.userId) }, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}) },
    orderBy: { name: "asc" },
    take: 30,
  });
  return users.map((u) => ({ id: u.id, label: u.name || u.email.split("@")[0], sub: u.email, url: `/workspace/chat?dm=${u.id}`, kind: "person", email: u.email }));
}

async function items(me: Me, app: string, q: string): Promise<Item[]> {
  if (app === "teamchat" && can(me, "teamchat.open")) {
    const [ppl, chans] = await Promise.all([
      people(me, q),
      db.channel.findMany({
        where: { ...channelsIn(me), kind: { not: "dm" }, ...(q ? { name: { contains: q.toLowerCase() } } : {}) },
        orderBy: { lastAt: "desc" },
        take: 15,
        select: { id: true, name: true, topic: true },
      }),
    ]);
    return [...ppl, ...chans.map((c) => ({ id: c.id, label: `#${c.name}`, sub: c.topic || "Channel", url: `/workspace/chat?channel=${c.id}`, kind: "item" as const }))];
  }
  if (app === "tasks" && can(me, "tasks.open")) {
    const key = /^([A-Za-z][A-Za-z0-9]{1,7})-(\d+)$/.exec(q);
    const rows = await db.task.findMany({
      where: {
        ...taskWhere(me),
        ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, ...(key ? [{ number: Number(key[2]), project: { key: key[1].toUpperCase() } }] : [])] } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: { id: true, title: true, number: true, status: true, completedAt: true, projectId: true, project: { select: { name: true, key: true } } },
    });
    return rows.map((t) => {
      const id = t.project.key ? `${t.project.key}-${t.number}` : "";
      return { id: t.id, label: id ? `${id} ${t.title}` : t.title, sub: `${t.project.name} · ${t.completedAt ? "done" : t.status}`, url: `/workspace/tasks?project=${t.projectId}&task=${t.id}`, kind: "item" as const };
    });
  }
  if (app === "calendar" && can(me, "calendar.open")) {
    const cals = await visibleCalendars(me);
    const rows = await db.event.findMany({
      where: {
        ws: me.ws,
        deletedAt: null,
        OR: [{ calendarId: { in: cals.map((c) => c.id) } }, { attendees: { some: { userId: me.userId } } }],
        ...(q ? { title: { contains: q, mode: "insensitive" } } : { start: { gte: new Date(Date.now() - 7 * 864e5) } }),
      },
      orderBy: { start: q ? "desc" : "asc" },
      take: 25,
      select: { id: true, title: true, start: true },
    });
    return rows.map((e) => ({ id: e.id, label: e.title, sub: e.start.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: me.tz }), url: `/workspace/calendar?event=${e.id}`, kind: "item" as const }));
  }
  if (app === "meetings" && can(me, "meetings.open")) {
    const rows = await db.meeting.findMany({
      where: { ...meetWhere(me), ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { code: true, title: true, createdAt: true, notesStatus: true },
    });
    return rows.map((m) => ({ id: m.code, label: m.title, sub: `${m.createdAt.toISOString().slice(0, 10)}${m.notesStatus === "ready" ? " · notes" : ""}`, url: `/workspace/meet/${m.code}/notes`, kind: "item" as const }));
  }
  if (app === "people") return people(me, q);
  return [];
}

const who = async (ids: string[]) => new Map((await db.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));

/** One referenced item as text, for the AI. Null when it isn't there or can't be seen. */
async function read(me: Me, ref: string): Promise<{ title: string; text: string } | null> {
  const u = new URL(ref, "http://x");
  const p = u.searchParams;
  if (u.pathname.startsWith("/workspace/tasks") && p.get("task") && can(me, "tasks.open")) {
    const t = await db.task.findFirst({
      where: { ...taskWhere(me), id: p.get("task")! },
      include: { project: { select: { name: true, key: true } }, comments: { orderBy: { createdAt: "desc" }, take: 15 } },
    });
    if (!t) return null;
    const names = await who([t.assigneeId ?? "", t.createdBy, ...t.comments.map((c) => c.userId)]);
    const id = t.project.key ? `${t.project.key}-${t.number} ` : "";
    return {
      title: `Task ${id}${t.title}`,
      text: [
        `Task ${id}"${t.title}" in project ${t.project.name}`,
        `Type: ${t.type} · Status: ${t.completedAt ? "done" : t.status} · Priority: ${["low", "normal", "high", "urgent"][t.priority] ?? t.priority}`,
        `Assignee: ${t.assigneeId ? (names.get(t.assigneeId) ?? "someone") : "nobody"} · Due: ${t.due?.toISOString().slice(0, 10) ?? "none"}${t.labels.length ? ` · Labels: ${t.labels.join(", ")}` : ""}`,
        t.description ? `Description:\n${t.description.slice(0, 6000)}` : "No description.",
        t.comments.length ? `Latest comments:\n${t.comments.reverse().map((c) => `- ${names.get(c.userId) ?? "someone"}: ${c.body.slice(0, 600)}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (u.pathname.startsWith("/workspace/chat") && can(me, "teamchat.open")) {
    const dm = p.get("dm");
    if (dm) {
      const n = await who([dm]);
      return n.get(dm) ? { title: n.get(dm)!, text: `A person in the workspace: ${n.get(dm)}` } : null;
    }
    const ch = p.get("channel") ? await db.channel.findFirst({ where: { ...channelsIn(me), id: p.get("channel")! } }) : null;
    if (!ch) return null;
    const msgs = await db.message.findMany({
      where: { channelId: ch.id, deletedAt: null, ...(p.get("thread") ? { OR: [{ id: p.get("thread")! }, { parentId: p.get("thread")! }] } : { OR: [{ parentId: null }, { alsoChannel: true }] }) },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { userId: true, body: true, createdAt: true },
    });
    const names = await who(msgs.map((m) => m.userId));
    const name = ch.kind === "dm" ? "a direct message" : `#${ch.name}`;
    return {
      title: name,
      text: `Team Chat ${name}${ch.topic ? ` (topic: ${ch.topic})` : ""}, latest ${msgs.length} messages, oldest first:\n${msgs
        .reverse()
        .map((m) => `[${m.createdAt.toISOString().slice(0, 16).replace("T", " ")}] ${names.get(m.userId) ?? "someone"}: ${m.body.slice(0, 1500)}`)
        .join("\n")}`,
    };
  }
  if (u.pathname.startsWith("/workspace/calendar") && p.get("event") && can(me, "calendar.open")) {
    const cals = await visibleCalendars(me);
    const e = await db.event.findFirst({
      where: { id: p.get("event")!, ws: me.ws, deletedAt: null, OR: [{ calendarId: { in: cals.map((c) => c.id) } }, { attendees: { some: { userId: me.userId } } }] },
      include: { attendees: true },
    });
    if (!e) return null;
    return {
      title: e.title,
      text: `Calendar event "${e.title}", ${e.start.toISOString()} to ${e.end.toISOString()}${e.location ? ` at ${e.location}` : ""}\nAttendees: ${e.attendees.map((a) => a.email ?? a.userId).join(", ") || "none"}\n${(e.description ?? "").slice(0, 4000)}`,
    };
  }
  const meet = /^\/workspace\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})/.exec(u.pathname);
  if (meet && can(me, "meetings.open")) {
    const m = await db.meeting.findFirst({ where: { ...meetWhere(me), code: meet[1] } });
    if (!m) return null;
    return {
      title: m.title,
      text: `Meeting "${m.title}" (${m.createdAt.toISOString().slice(0, 10)})\nNotes: ${m.notes ? JSON.stringify(m.notes).slice(0, 8000) : "none yet"}\n${m.transcript ? `Transcript (start):\n${m.transcript.slice(0, 8000)}` : ""}`,
    };
  }
  return null;
}

async function GET_(req: Request) {
  const me = await requireMe();
  const s = new URL(req.url).searchParams;
  const ref = s.get("ref");
  if (ref) {
    const got = await read(me, ref.slice(0, 500));
    return got ? Response.json(got) : Response.json({ error: "Not found" }, { status: 404 });
  }
  const q = (s.get("q") ?? "").trim().slice(0, 100);
  return Response.json({ items: await items(me, s.get("app") ?? "", q) });
}

export const GET = route(GET_);
