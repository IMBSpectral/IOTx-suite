import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { requirePerm } from "@/lib/iotx/permissions";
import { findTemplate, STYLES } from "@/lib/templates";
import { createProject, findRecentDuplicate } from "@/lib/create-project";
import { listProjects, type View } from "@/lib/projects";
import { readFile, listFiles } from "@/lib/repo";
import { route } from "@/lib/route";
import { initDesignSystem } from "@/lib/design-systems";
import { cleanEnv, EnvError, writeEnv } from "@/lib/env-vars";
import { initCanvas } from "@/lib/canvas";

const VIEWS = new Set<View>(["all", "mine", "recent", "starred", "shared", "published", "popular", "design_systems", "templates", "hidden", "deleted"]);

/** ?view=…&folder=<id>|root&q=… */
async function GET_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  const url = new URL(req.url);
  const view = (url.searchParams.get("view") ?? "all") as View;
  const folder = url.searchParams.get("folder");
  const projects = await listProjects({
    userId: user.id,
    workspaceId: ws.id,
    view: VIEWS.has(view) ? view : "all",
    folderId: folder === null ? undefined : folder === "root" ? null : folder,
    q: url.searchParams.get("q") ?? undefined,
  });
  return NextResponse.json({ projects });
}

/**
 * Create a project from a prompt, a built-in template (with an optional
 * style), or another project marked as a workspace template. A prompt that
 * matches a project started in the last day returns 409 unless `force`.
 */
async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requirePerm(user.id, ws.id, "builder.project.create");
  const { name, template, style, fromProject, force, kind, env } = (await req.json()) as {
    name?: string;
    template?: string;
    style?: string;
    fromProject?: string;
    force?: boolean;
    kind?: "app" | "design_system" | "canvas" | "library";
    /** Environment variables set at creation ("Environment variables (optional)"). */
    env?: { name: string; value: string }[];
  };
  let envVars: Record<string, string> = {};
  try {
    envVars = cleanEnv(env);
  } catch (e) {
    if (e instanceof EnvError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  // Design systems and canvases start from their own content, not an app prompt.
  if (kind === "design_system" || kind === "canvas") {
    const label = (name?.trim() || (kind === "canvas" ? "Untitled canvas" : "Untitled design system")).slice(0, 80);
    const project = await createProject({ workspaceId: ws.id, userId: user.id, name: label });
    if (kind === "design_system") await initDesignSystem(project.id, label);
    else await initCanvas(project.id);
    return Response.json({ project: await db.project.findUnique({ where: { id: project.id } }), seed: null }, { status: 201 });
  }

  // A library project holds reusable components other projects copy from.
  if (kind === "library") {
    const label = (name?.trim() || "Component library").slice(0, 80);
    const project = await createProject({ workspaceId: ws.id, userId: user.id, name: label });
    await db.project.update({ where: { id: project.id }, data: { kind: "library" } });
    return NextResponse.json(
      {
        project: await db.project.findUnique({ where: { id: project.id } }),
        seed:
          `This is a component library called "${label}" for this workspace's other projects. Build reusable, self-contained ` +
          "React components under src/library/<ComponentName>/ (each with an index.tsx, typed props and no app-specific data), " +
          "a src/library/index.ts that exports them all, and make the app itself a showcase page listing every component with a live example. " +
          "Start with Button, Card, Input, Modal and Navbar.",
      },
      { status: 201 },
    );
  }

  // A workspace template is a project: using it copies its files.
  if (fromProject) {
    const source = await db.project.findFirst({
      where: { id: fromProject, workspaceId: ws.id, isTemplate: true, deletedAt: null },
    });
    if (!source) return NextResponse.json({ error: "Template not found" }, { status: 404 });
    const files = [];
    for (const path of await listFiles(source.id)) {
      files.push({ path, bytes: Buffer.from(await readFile(source.id, path), "utf8") });
    }
    const project = await createProject({
      workspaceId: ws.id,
      userId: user.id,
      name: `${source.name} (copy)`,
      files,
      message: `Start from template: ${source.name}`,
    });
    return NextResponse.json({ project, seed: null }, { status: 201 });
  }

  const seed = template ? findTemplate(template) : undefined;
  const label = (seed?.name ?? name ?? "Untitled project").slice(0, 80);

  if (!seed && !force) {
    const dup = await findRecentDuplicate(ws.id, label);
    if (dup) {
      return NextResponse.json(
        { error: "duplicate", message: "You already started this project.", project: dup },
        { status: 409 },
      );
    }
  }

  const project = await createProject({ workspaceId: ws.id, userId: user.id, name: label });
  if (Object.keys(envVars).length) await writeEnv(project.id, envVars);
  const styleNote = style && STYLES[style] ? `\n\nVisual style: ${STYLES[style]}` : "";

  // The seed prompt is handed back rather than queued here, so the first
  // build streams into the editor the user is about to land on.
  return NextResponse.json(
    { project, seed: seed ? seed.prompt + styleNote : null },
    { status: 201 },
  );
}

export const GET = route(GET_);
export const POST = route(POST_);
