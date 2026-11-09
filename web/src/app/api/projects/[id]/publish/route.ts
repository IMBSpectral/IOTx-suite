import { requireProjectPerm } from "@/lib/iotx/permissions";
import { RESERVED_SUBDOMAINS } from "@/lib/site-host";
import { getBrand } from "@/lib/brand";
import { db } from "@/lib/db";
import { runCheckHooks } from "@/lib/event-destinations";
import { entitlementsFor, projectEntitlements } from "@/lib/entitlements";
import { audit } from "@/lib/workspace-security";
import { requireUser, requireProject } from "@/lib/workspace";
import {
  publishProject,
  publishState,
  runChecks,
  unpublish,
  PublishBlocked,
  normalizeRoute,
  type PageSeo,
  type Seo,
  type StepId,
} from "@/lib/publish";
import { route } from "@/lib/route";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const AUDIENCES = new Set(["public", "workspace", "private"]);

/** Per-page overrides: at most 50 pages, empty ones dropped. */
function pagesOf(
  raw: unknown,
  clean: (v: unknown, max: number) => string | undefined,
  url: (v: unknown) => string | undefined,
): Record<string, PageSeo> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, PageSeo> = {};
  for (const [path, v] of Object.entries(
    raw as Record<string, Record<string, unknown>>,
  ).slice(0, 50)) {
    if (
      !v ||
      typeof v !== "object" ||
      typeof path !== "string" ||
      !path.startsWith("/")
    )
      continue;
    const page = {
      title: clean(v.title, 120) || undefined,
      description: clean(v.description, 300) || undefined,
      ogImage: url(v.ogImage),
    };
    if (page.title || page.description || page.ogImage)
      out[normalizeRoute(path)] = page;
  }
  return Object.keys(out).length ? out : undefined;
}

async function role(userId: string, workspaceId: string) {
  const m = await db.membership.findFirst({
    where: { userId, workspaceId },
    select: { role: true },
  });
  return m?.role ?? null;
}

/** Everything the publish dialog shows: button state, URL, audience, checks. */
async function GET_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: project.workspaceId },
  });
  const r = await role(user.id, project.workspaceId);
  return Response.json({
    ...(await publishState(id)),
    requiresApproval:
      ws.publishRequiresApproval && r !== "OWNER" && r !== "ADMIN",
    canApprove: r === "OWNER" || r === "ADMIN",
    entitlements: entitlementsFor(ws.plan),
  });
}

/**
 * Publish, streaming progress as server-sent events so the dialog can show
 * each step. Body: { action: "publish" | "check" | "request" }.
 */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.publish");
  const { action = "publish" } = (await req.json().catch(() => ({}))) as {
    action?: string;
  };

  if (
    (await db.build.count({ where: { projectId: id, status: "RUNNING" } })) > 0
  ) {
    return Response.json(
      { ok: false, error: "Wait for the agent to finish before publishing." },
      { status: 409 },
    );
  }

  // Governance: members of a workspace that requires approval ask an admin.
  const ws = await db.workspace.findUniqueOrThrow({
    where: { id: project.workspaceId },
  });
  const r = await role(user.id, project.workspaceId);
  const isAdmin = r === "OWNER" || r === "ADMIN";
  if (
    action === "request" ||
    (action === "publish" && ws.publishRequiresApproval && !isAdmin)
  ) {
    await db.project.update({
      where: { id },
      data: { publishRequestedAt: new Date(), publishRequestedById: user.id },
    });
    const admins = await db.membership.findMany({
      where: {
        workspaceId: project.workspaceId,
        role: { in: ["OWNER", "ADMIN"] },
      },
      select: { userId: true },
    });
    await db.notification.createMany({
      data: admins.map((a) => ({
        userId: a.userId,
        projectId: id,
        kind: "publish_request",
        title: `Publish requested: ${project.name}`,
        body: "A member asked to publish this project.",
        href: `/projects/${id}`,
      })),
    });
    return Response.json({ ok: true, requested: true });
  }

  // The workspace's check hooks can stop a publish before it starts.
  if (action === "publish") {
    const verdict = await runCheckHooks(project.workspaceId, "publish", { projectId: id, projectName: project.name, by: user.email });
    if (!verdict.allow) return Response.json({ ok: false, error: verdict.reason }, { status: 403 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      const onStep = (step: StepId) => send({ type: "step", step });
      try {
        if (action === "check") {
          const result = await runChecks(id, onStep);
          send({ type: "checks", result });
        } else {
          const result = await publishProject(id, onStep);
          await audit(
            project.workspaceId,
            user.id,
            "project.published",
            `Published "${project.name}" at ${result.url}`,
            id,
          );
          send({
            type: "published",
            url: result.url,
            sha: result.sha,
            checks: result.checks,
          });
        }
      } catch (err) {
        if (err instanceof PublishBlocked)
          send({ type: "blocked", result: err.result });
        else
          send({
            type: "error",
            message: err instanceof Error ? err.message : "Publish failed",
          });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}

/** Publish settings: audience, badge, search/social appearance, subdomain. */
async function PATCH_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.publish");
  const body = (await req.json().catch(() => ({}))) as {
    audience?: string;
    showBadge?: boolean;
    seo?: Seo;
    subdomain?: string;
  };
  if (typeof body.subdomain === "string") await requireProjectPerm(user.id, id, "builder.domain.subdomain");
  const data: Record<string, unknown> = {};
  if (body.audience !== undefined) {
    if (!AUDIENCES.has(body.audience))
      return Response.json({ error: "Unknown audience" }, { status: 400 });
    data.publishAudience = body.audience;
  }
  if (typeof body.showBadge === "boolean") {
    if (!body.showBadge && !(await projectEntitlements(id)).hideBadge) {
      return Response.json(
        {
          error:
            `Hiding the ${getBrand().name} badge needs a paid plan. Upgrade in Settings → Billing.`,
          upgrade: true,
        },
        { status: 402 },
      );
    }
    data.showBadge = body.showBadge;
  }
  if (body.seo) {
    const clean = (v: unknown, max: number) =>
      typeof v === "string" ? v.trim().slice(0, max) : undefined;
    const url = (v: unknown) => {
      const s = clean(v, 1000);
      return s && (/^https?:\/\//.test(s) || s.startsWith("/")) ? s : undefined;
    };
    data.seo = {
      title: clean(body.seo.title, 120) || undefined,
      description: clean(body.seo.description, 300) || undefined,
      ogImage: url(body.seo.ogImage),
      favicon: url(body.seo.favicon),
      pages: pagesOf(body.seo.pages, clean, url),
    };
  }
  if (typeof body.subdomain === "string") {
    const sub = body.subdomain.trim().toLowerCase();
    // "--" is reserved for preview hosts (preview--<token>).
    // 2–63 characters: short names like "hr" are fine. "--" is reserved for preview hosts.
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(sub) || sub.includes("--")) {
      return Response.json(
        {
          error:
            "Use 2–63 lowercase letters, numbers or hyphens, not starting or ending with a hyphen.",
        },
        { status: 400 },
      );
    }
    if (RESERVED_SUBDOMAINS.has(sub)) {
      return Response.json({ error: `"${sub}" is reserved for the platform. Pick another address.` }, { status: 400 });
    }
    data.subdomain = sub;
  }
  try {
    await db.project.update({ where: { id }, data });
  } catch {
    return Response.json(
      { error: "That address is already taken." },
      { status: 409 },
    );
  }
  return Response.json(await publishState(id));
}

async function DELETE_(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.publish");
  await unpublish(id);
  await audit(
    project.workspaceId,
    user.id,
    "project.unpublished",
    `Unpublished "${project.name}"`,
    id,
  );
  return Response.json({ ok: true });
}

export const GET = route(GET_);
export const POST = route(POST_);
export const PATCH = route(PATCH_);
export const DELETE = route(DELETE_);
