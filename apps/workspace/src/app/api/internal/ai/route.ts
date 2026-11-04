import crypto from "node:crypto";
import { HttpError, type Me } from "@/lib/auth";
import { db } from "@/lib/db";
import { withAiContext } from "@/lib/ai-meter";
import { addComment, createTask, listTasks, taskDetail, updateTask, type TaskInput } from "@/lib/tasks";
import { defaultProject, listProjects } from "@/lib/tasks-plan";
import { createEvent, deleteEvent, occurrences, people, updateEvent, type EventInput } from "@/lib/calendar";
import { afterLocalChange } from "@/lib/google";
import { listChannels, listMessages, openDm, postMessage, search as searchChat } from "@/lib/chat";
import { handleRpc } from "@/lib/meet/mcp";
import { createMeeting, linkEvent, meetingForEvent, meetingUrl } from "@/lib/meet/meetings";
import { EMAIL_ORIGIN } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The suite's AI acting in Workspace (Tasks, Calendar, Chat, Meet) as one
 * person, server to server (x-iotx-key). The suite sends who it is and the
 * permission switches its role has; each tool needs the same switches the
 * app's own screens do, and runs through the same functions (so visibility,
 * membership and project roles apply as usual).
 *   POST { userId, ws, owner, perms: string[], tool, input } -> { result } | { error }
 */
function keyOk(req: Request) {
  const want = process.env.IOTX_SERVICE_KEY;
  const given = req.headers.get("x-iotx-key");
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type In = Record<string, unknown>;
const s = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const need = (me: Me, ...keys: string[]) => {
  for (const k of keys) if (!me.perms[k]) throw new HttpError(403, `This person's role doesn't allow that (${k} is off).`);
};

/** Meet reports go through the Meet MCP server's own tools. */
async function meet(me: Me, name: string, args: In) {
  const r = await handleRpc(me, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never);
  if (r?.error) throw new HttpError(400, r.error.message);
  const res = r?.result as { content?: { type: string; text?: string }[] } | undefined;
  return (res?.content ?? []).map((c) => c.text ?? "").join("\n");
}

/** Meeting links are built from a request's address; here that's the public site, not this server-to-server call. */
const publicReq = () => {
  const u = new URL(EMAIL_ORIGIN);
  return new Request(EMAIL_ORIGIN, { headers: { host: u.host, "x-forwarded-proto": u.protocol.replace(":", "") } });
};

/** A person by id, email or name, among the workspace's people. */
async function who(ws: string, ref: string) {
  const all = await people(ws);
  const r = ref.toLowerCase();
  return all.find((p) => p.id === ref || p.email?.toLowerCase() === r) ?? all.find((p) => (p.name ?? "").toLowerCase() === r) ?? all.find((p) => (p.name ?? "").toLowerCase().includes(r));
}

const TOOLS: Record<string, (me: Me, i: In) => Promise<unknown>> = {
  // ── People ──
  people: async (me, i) => {
    const q = s(i.q)?.toLowerCase();
    const all = await people(me.ws);
    return all.filter((p) => !q || `${p.name ?? ""} ${p.email ?? ""}`.toLowerCase().includes(q)).slice(0, 50);
  },

  // ── Tasks ──
  task_projects: async (me) => {
    need(me, "tasks.open");
    return (await listProjects(me)).map((p) => ({ id: p.id, key: p.key, name: p.name, statuses: (p as { statuses?: unknown }).statuses }));
  },
  task_search: async (me, i) => {
    need(me, "tasks.open");
    const r = await listTasks(me, {
      q: s(i.query, 400),
      text: s(i.text, 200),
      projectId: s(i.projectId, 60),
      mine: i.mine === true,
      open: i.open === false ? undefined : true,
      due: ["overdue", "today", "week", "none"].includes(String(i.due)) ? (i.due as "overdue") : undefined,
      sort: "updated",
      dir: "desc",
    });
    const list = (r as { tasks?: unknown[] }).tasks ?? (Array.isArray(r) ? r : []);
    return { tasks: (list as unknown[]).slice(0, Math.min(Number(i.limit) || 25, 50)) };
  },
  /** A manager's view: each person's open tasks, in the projects the manager can see. */
  team_tasks: async (me, i) => {
    need(me, "tasks.open");
    const ids = Array.isArray(i.userIds) ? i.userIds.map(String).slice(0, 100) : [];
    const today = new Date(new Date().toISOString().slice(0, 10));
    const out: Record<string, { open: number; overdue: number; dueThisWeek: number; top: unknown[] }> = {};
    for (const id of ids) {
      const r = await listTasks(me, { assignee: id, open: true, sort: "due", dir: "asc" });
      const list = ((r as { tasks?: unknown[] }).tasks ?? (Array.isArray(r) ? r : [])) as { key?: string; title?: string; due?: string | null; status?: string; statusName?: string; priority?: number }[];
      const due = (t: { due?: string | null }) => (t.due ? new Date(t.due) : null);
      out[id] = {
        open: list.length,
        overdue: list.filter((t) => due(t) && due(t)! < today).length,
        dueThisWeek: list.filter((t) => due(t) && due(t)! >= today && due(t)!.getTime() <= today.getTime() + 7 * 86_400_000).length,
        top: list.slice(0, 5).map((t) => ({ key: t.key, title: t.title, due: t.due ?? null, status: t.statusName ?? t.status, priority: t.priority })),
      };
    }
    return out;
  },
  task_get: async (me, i) => {
    need(me, "tasks.open");
    return taskDetail(me, s(i.key, 60) ?? "");
  },
  task_create: async (me, i) => {
    need(me, "tasks.open", "tasks.create");
    // No project named: the person's only project, else the company's default "General" project.
    let projectId = s(i.projectId, 60);
    if (projectId && !/^c[a-z0-9]{20,}$/.test(projectId)) {
      const byName = (await listProjects(me)).find((p) => p.key?.toLowerCase() === projectId!.toLowerCase() || p.name.toLowerCase() === projectId!.toLowerCase());
      projectId = byName?.id ?? undefined;
    }
    if (!projectId) {
      const mine = await listProjects(me);
      projectId = mine.length === 1 ? mine[0].id : (await defaultProject(me)).id;
    }
    const input: TaskInput = { projectId, title: s(i.title, 300), description: s(i.description, 20_000), type: s(i.type, 30), due: s(i.due, 40) ?? null, priority: typeof i.priority === "number" ? i.priority : undefined, labels: Array.isArray(i.labels) ? i.labels.map(String).slice(0, 10) : undefined };
    if (s(i.assignee)) {
      const p = await who(me.ws, s(i.assignee)!);
      if (!p) throw new HttpError(400, `No one called "${s(i.assignee)}" in this workspace.`);
      if (p.id !== me.userId) need(me, "tasks.assign");
      input.assigneeId = p.id;
    } else input.assigneeId = me.userId;
    return createTask(me, input);
  },
  task_update: async (me, i) => {
    need(me, "tasks.open");
    const input: TaskInput = {};
    for (const k of ["title", "description", "status", "due", "type"] as const) if (s(i[k], 20_000) !== undefined) (input as In)[k] = s(i[k], 20_000);
    if (typeof i.priority === "number") input.priority = i.priority;
    if (s(i.assignee) !== undefined) {
      if (s(i.assignee) === "") input.assigneeId = null;
      else {
        const p = await who(me.ws, s(i.assignee)!);
        if (!p) throw new HttpError(400, `No one called "${s(i.assignee)}" in this workspace.`);
        if (p.id !== me.userId) need(me, "tasks.assign");
        input.assigneeId = p.id;
      }
    }
    return updateTask(me, s(i.key, 60) ?? "", input);
  },
  task_comment: async (me, i) => {
    need(me, "tasks.open");
    return addComment(me, s(i.key, 60) ?? "", s(i.body, 10_000) ?? "");
  },

  // ── Calendar ──
  calendar_events: async (me, i) => {
    need(me, "calendar.open");
    const from = new Date(s(i.from, 40) ?? Date.now());
    const to = new Date(s(i.to, 40) ?? from.getTime() + 7 * 86_400_000);
    if (Number.isNaN(+from) || Number.isNaN(+to)) throw new HttpError(400, "from and to must be ISO dates.");
    if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new HttpError(400, "Ask for at most three months at a time.");
    return (await occurrences(me, from, to)).slice(0, 200);
  },
  calendar_create: async (me, i) => {
    need(me, "calendar.open", "calendar.create");
    const attendees: EventInput["attendees"] = [];
    for (const a of Array.isArray(i.attendees) ? i.attendees.map(String).slice(0, 50) : []) {
      const p = await who(me.ws, a);
      if (p) attendees.push({ userId: p.id });
      else if (a.includes("@")) attendees.push({ email: a });
      else throw new HttpError(400, `No one called "${a}" in this workspace (give an email for someone outside).`);
    }
    const input: EventInput = { title: s(i.title, 300), description: s(i.description, 8000), location: s(i.location, 300), start: s(i.start, 40), end: s(i.end, 40), allDay: i.allDay === true, tz: s(i.tz, 60) ?? me.tz, attendees };
    // An IOTx Meet video call as the event's link (needs "Start and schedule meetings").
    if (i.videoMeeting === true) need(me, "meetings.open", "meetings.create");
    const vm = i.videoMeeting === true ? await meetingForEvent(me, publicReq(), input) : null;
    const ev = await createEvent(me, vm ? { ...input, conferenceUrl: vm.url } : input);
    if (vm) await linkEvent(vm.id, ev.id);
    await afterLocalChange(me.userId, me.ws, ev.id, !!me.perms["calendar.google"]);
    return { ...ev, meetingLink: vm?.url ?? null };
  },
  calendar_update: async (me, i) => {
    need(me, "calendar.open", "calendar.create");
    const input: EventInput = {};
    for (const k of ["title", "description", "location", "start", "end"] as const) if (s(i[k], 8000) !== undefined) (input as In)[k] = s(i[k], 8000);
    const ev = await updateEvent(me, s(i.id, 80) ?? "", input);
    await afterLocalChange(me.userId, me.ws, s(i.id, 80) ?? "", !!me.perms["calendar.google"]);
    return ev;
  },
  calendar_delete: async (me, i) => {
    need(me, "calendar.open", "calendar.create");
    await deleteEvent(me, s(i.id, 80) ?? "");
    await afterLocalChange(me.userId, me.ws, s(i.id, 80) ?? "", !!me.perms["calendar.google"]);
    return { deleted: true };
  },

  // ── Team chat ──
  chat_channels: async (me) => {
    need(me, "teamchat.open");
    return listChannels(me);
  },
  chat_read: async (me, i) => {
    need(me, "teamchat.open");
    return listMessages(me, s(i.channelId, 80) ?? "", { limit: Math.min(Number(i.limit) || 40, 100), thread: s(i.threadId, 80) });
  },
  chat_search: async (me, i) => {
    need(me, "teamchat.open");
    return searchChat(me, s(i.query, 200) ?? "");
  },
  chat_post: async (me, i) => {
    need(me, "teamchat.open");
    let channelId = s(i.channelId, 80);
    if (!channelId && s(i.to)) {
      const p = await who(me.ws, s(i.to)!);
      if (!p) throw new HttpError(400, `No one called "${s(i.to)}" in this workspace.`);
      channelId = ((await openDm(me, [p.id])) as { id: string }).id;
    }
    if (!channelId) throw new HttpError(400, "Give a channelId, or `to` for a direct message.");
    return postMessage(me, channelId, { body: s(i.body, 12_000), parentId: s(i.threadId, 80) });
  },

  // ── Meet ──
  meeting_create: async (me, i) => {
    need(me, "meetings.open", "meetings.create");
    const invitees: string[] = [];
    for (const a of Array.isArray(i.invite) ? i.invite.map(String).slice(0, 50) : []) {
      const p = await who(me.ws, a);
      if (!p) throw new HttpError(400, `No one called "${a}" in this workspace.`);
      invitees.push(p.id);
    }
    const m = await createMeeting(me, { title: s(i.title, 200) || "Meeting", invitees });
    return { title: m.title, code: m.code, link: meetingUrl(publicReq(), m.code) };
  },
  meetings_search: async (me, i) => {
    need(me, "meetings.open");
    return meet(me, "search_meetings", i);
  },
  meeting_report: async (me, i) => {
    need(me, "meetings.open");
    return meet(me, "get_report", i);
  },
  meeting_action_items: async (me, i) => {
    need(me, "meetings.open");
    return meet(me, "list_action_items", i);
  },
};

export async function POST(req: Request) {
  if (!keyOk(req)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { userId?: string; ws?: string; owner?: boolean; perms?: string[]; tool?: string; input?: In };
  const run = TOOLS[String(b.tool)];
  if (!run || !b.userId || !b.ws) return Response.json({ error: "Unknown tool or missing person." }, { status: 400 });
  const u = await db.user.findUnique({ where: { id: b.userId } });
  if (!u) return Response.json({ error: "This person hasn't opened Workspace yet, so nothing there belongs to them. Ask them to open Tasks or Calendar once." }, { status: 404 });
  const perms = Object.fromEntries((Array.isArray(b.perms) ? b.perms : []).map((k) => [String(k), true]));
  const me: Me = { sid: "ai", userId: u.id, ws: b.ws, name: u.name ?? u.email, email: u.email, tz: u.tz, owner: !!b.owner, perms, stale: false, guest: false };
  try {
    const result = await withAiContext({ userId: u.id, workspaceId: b.ws }, () => run(me, b.input ?? {}));
    return Response.json({ result });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: 200 });
    console.error("[internal/ai]", e);
    return Response.json({ error: "Something went wrong in Workspace." }, { status: 200 });
  }
}
