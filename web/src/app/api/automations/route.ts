import { requirePerm } from "@/lib/iotx/permissions";
import { db } from "@/lib/db";
import { requireUser, currentWorkspace, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { describeSchedule } from "@/lib/cron";
import { AutomationError, ensureAutomations, runAutomation, setWebhook, tickAutomations, validateSchedule, webhookUrl } from "@/lib/automations";

/** The workspace's automations, with their schedule in words and the project name. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  ensureAutomations();
  const rows = await db.automation.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "desc" } });
  const projects = await db.project.findMany({
    where: { id: { in: rows.map((r) => r.projectId) } },
    select: { id: true, name: true },
  });
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return Response.json({
    automations: rows.map(({ webhookToken, ...a }) => ({
      ...a,
      webhookUrl: webhookToken ? webhookUrl(webhookToken) : null,
      projectName: name.get(a.projectId) ?? "Deleted project",
      scheduleText: describeSchedule(a.schedule, a.timezone),
    })),
  });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const body = (await req.json().catch(() => ({}))) as {
    action?: "create" | "update" | "run" | "pause" | "resume" | "delete" | "tick" | "webhook";
    on?: boolean;
    id?: string;
    projectId?: string;
    name?: string;
    prompt?: string;
    mode?: string;
    schedule?: string;
    timezone?: string;
  };
  ensureAutomations();
  // Automations run builds on a schedule: they need Build mode (pausing and deleting do not).
  if (body.action === "create" || body.action === "update" || body.action === "run" || body.action === "resume" || body.action === "webhook") await requirePerm(user.id, ws.id, "builder.build");
  const own = async () => {
    const a = await db.automation.findFirst({ where: { id: body.id ?? "", workspaceId: ws.id } });
    if (!a) throw new AutomationError("Automation not found");
    await requireProject(user.id, a.projectId, "edit");
    return a;
  };
  try {
    switch (body.action) {
      case "create": {
        await requireProject(user.id, body.projectId ?? "", "edit");
        const name = body.name?.trim().slice(0, 80);
        const prompt = body.prompt?.trim().slice(0, 4000);
        if (!name || !prompt) return Response.json({ error: "Give it a name and a prompt." }, { status: 400 });
        const timezone = body.timezone || "UTC";
        const next = validateSchedule(body.schedule ?? "", timezone);
        const a = await db.automation.create({
          data: {
            workspaceId: ws.id,
            projectId: body.projectId!,
            name,
            prompt,
            mode: body.mode === "ask" || body.mode === "plan" ? body.mode : "build",
            schedule: body.schedule!,
            timezone,
            nextRunAt: next,
            createdById: user.id,
          },
        });
        return Response.json({ ok: true, id: a.id, nextRunAt: a.nextRunAt }, { status: 201 });
      }
      case "update": {
        const a = await own();
        const timezone = body.timezone || a.timezone;
        const schedule = body.schedule ?? a.schedule;
        const next = a.status === "active" ? validateSchedule(schedule, timezone) : null;
        await db.automation.update({
          where: { id: a.id },
          data: {
            name: body.name?.trim().slice(0, 80) || a.name,
            prompt: body.prompt?.trim().slice(0, 4000) || a.prompt,
            schedule,
            timezone,
            nextRunAt: next,
          },
        });
        return Response.json({ ok: true });
      }
      case "run": {
        const a = await own();
        const turn = await runAutomation(a.id, "manual");
        if (!turn) return Response.json({ error: "Paused: out of credits or at a spending limit." }, { status: 402 });
        return Response.json({ ok: true, ...turn });
      }
      case "pause": {
        const a = await own();
        await db.automation.update({ where: { id: a.id }, data: { status: "paused", pausedReason: "manual", nextRunAt: null } });
        return Response.json({ ok: true });
      }
      case "resume": {
        const a = await own();
        const next = validateSchedule(a.schedule, a.timezone);
        await db.automation.update({ where: { id: a.id }, data: { status: "active", pausedReason: null, failures: 0, nextRunAt: next } });
        return Response.json({ ok: true, nextRunAt: next });
      }
      case "delete": {
        const a = await own();
        await db.automation.delete({ where: { id: a.id } });
        return Response.json({ ok: true });
      }
      case "webhook": {
        const a = await own();
        const token = await setWebhook(a.id, !!body.on);
        return Response.json({ ok: true, webhookUrl: token ? webhookUrl(token) : null });
      }
      case "tick":
        // Lets the page settle results right away instead of waiting a minute.
        return Response.json(await tickAutomations());
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof AutomationError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
