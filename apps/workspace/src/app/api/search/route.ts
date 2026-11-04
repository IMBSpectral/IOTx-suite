import { db } from "@/lib/db";
import { can, requireMe } from "@/lib/auth";
import { search as searchMessages } from "@/lib/chat";
import { visibleCalendars } from "@/lib/calendar";
import { route } from "@/lib/http";

/**
 * GET ?q= -> { events, tasks, messages } for the top bar's search box on
 * Calendar, Tasks and Chat pages. Only what the person can already see.
 */
async function GET_(req: Request) {
  const me = await requireMe();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  if (q.length < 2) return Response.json({ events: [], tasks: [], messages: [] });
  const [events, tasks, messages] = await Promise.all([
    can(me, "calendar.open")
      ? visibleCalendars(me).then((cals) =>
          db.event.findMany({
            where: {
              ws: me.ws,
              deletedAt: null,
              title: { contains: q, mode: "insensitive" },
              OR: [{ calendarId: { in: cals.map((c) => c.id) } }, { attendees: { some: { userId: me.userId } } }],
            },
            orderBy: { start: "desc" },
            take: 8,
            select: { id: true, title: true, start: true, allDay: true, rrule: true },
          }),
        )
      : [],
    can(me, "tasks.open")
      ? db.task.findMany({
          where: { ws: me.ws, OR: [{ title: { contains: q, mode: "insensitive" } }, ...(/^[A-Za-z][A-Za-z0-9]{1,7}-\d+$/.test(q.trim()) ? [{ number: Number(q.trim().split("-")[1]), project: { key: q.trim().split("-")[0].toUpperCase() } }] : [])], project: { archived: false, members: { some: { userId: me.userId } } } },
          orderBy: { updatedAt: "desc" },
          take: 8,
          select: { id: true, title: true, status: true, completedAt: true, number: true, due: true, projectId: true, project: { select: { name: true, key: true } } },
        })
      : [],
    can(me, "teamchat.open") ? searchMessages(me, q).then((r) => r.slice(0, 8)) : [],
  ]);
  return Response.json({
    events: events.map((e) => ({ id: e.id, title: e.title, start: e.start.toISOString(), allDay: e.allDay, repeats: !!e.rrule, href: `/workspace/calendar?event=${e.id}` })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.project.key ? `${t.project.key}-${t.number} ${t.title}` : t.title, status: t.completedAt ? "done" : t.status, due: t.due?.toISOString().slice(0, 10) ?? null, project: t.project.name, href: `/workspace/tasks?project=${t.projectId}&task=${t.id}` })),
    messages: messages.map((m) => ({ id: m.id, body: m.body.slice(0, 160), where: m.channelKind === "dm" ? "Direct message" : `#${m.channelName}`, href: `/workspace/chat?channel=${m.channelId}&message=${m.id}${m.parentId ? `&thread=${m.parentId}` : ""}` })),
  });
}

export const GET = route(GET_);
