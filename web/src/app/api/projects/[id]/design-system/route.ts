import { db } from "@/lib/db";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import {
  attachDesignSystem,
  DesignSystemError,
  initDesignSystem,
  publishDesignSystem,
  readTokens,
  saveTokens,
  tokensFromApp,
  type Tokens,
} from "@/lib/design-systems";
import { createProject } from "@/lib/create-project";

type Ctx = { params: Promise<{ id: string }> };

/**
 * For a design system: its tokens and version. For an app: which design
 * system is attached, whether an update is available, and the ones it could use.
 */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id);
  if (project.kind === "design_system") {
    return Response.json({ kind: "design_system", tokens: await readTokens(id), version: project.dsVersion });
  }
  const systems = await db.project.findMany({
    where: { workspaceId: project.workspaceId, kind: "design_system", deletedAt: null },
    select: { id: true, name: true, dsVersion: true },
    orderBy: { updatedAt: "desc" },
  });
  const attached = systems.find((s) => s.id === project.designSystemId);
  return Response.json({
    kind: project.kind,
    attached: attached
      ? {
          id: attached.id,
          name: attached.name,
          installed: project.designSystemVersion,
          latest: attached.dsVersion,
          updateAvailable: attached.dsVersion > (project.designSystemVersion ?? 0),
        }
      : null,
    available: systems.filter((s) => s.dsVersion > 0),
  });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  const body = (await req.json().catch(() => ({}))) as { action?: string; tokens?: Tokens; designSystemId?: string };
  try {
    switch (body.action) {
      case "save":
        if (project.kind !== "design_system") throw new DesignSystemError("Not a design system.");
        return Response.json({ ok: true, tokens: await saveTokens(id, body.tokens as Tokens) });
      case "publish":
        return Response.json({ ok: true, version: await publishDesignSystem(id) });
      case "attach":
        return Response.json({ ok: true, ...(await attachDesignSystem(id, body.designSystemId ?? "")) });
      case "update":
        if (!project.designSystemId) throw new DesignSystemError("No design system is attached.");
        return Response.json({ ok: true, ...(await attachDesignSystem(id, project.designSystemId)) });
      case "extract": {
        // "Create a design system from this app": its colours, fonts and radius become a new, published design system.
        if (project.kind !== "app") throw new DesignSystemError("Only apps can be turned into a design system.");
        const name = `${project.name} design system`.slice(0, 60);
        const tokens = await tokensFromApp(id, name);
        const ds = await createProject({ workspaceId: project.workspaceId, userId: user.id, name });
        await initDesignSystem(ds.id, name);
        await saveTokens(ds.id, tokens);
        const version = await publishDesignSystem(ds.id);
        return Response.json({ ok: true, designSystemId: ds.id, version, tokens }, { status: 201 });
      }
      case "detach":
        // The installed tokens stay in the code; the app just stops following updates.
        await db.project.update({ where: { id }, data: { designSystemId: null, designSystemVersion: null } });
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof DesignSystemError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
