import { requireProjectPerm } from "@/lib/iotx/permissions";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { assertCredits, InsufficientCredits, SpendLimitReached } from "@/lib/credits";
import { applyTextChanges, quickEdit, QuickEditError, undoQuickEdit, locateSource } from "@/lib/quick-edit";

export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

/** Quick edit of a selected element, batched text changes, or undo of the last one. */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.visual_edit");
  const body = (await req.json().catch(() => ({}))) as {
    action?: "edit" | "text" | "undo" | "locate";
    instruction?: string;
    selector?: string;
    text?: string;
    changes?: { oldText?: string; newText?: string }[];
  };

  try {
    if (body.action === "undo") return Response.json({ ok: true, ...(await undoQuickEdit(id)) });

    // Where the selected element lives in the code (no credits, no changes).
    if (body.action === "locate") {
      const at = await locateSource(id, { selector: body.selector ?? "", text: body.text ?? "" });
      return at ? Response.json(at) : Response.json({ error: "Couldn't find this element in the code." }, { status: 404 });
    }

    if (body.action === "text") {
      const changes = (body.changes ?? [])
        .filter((c) => typeof c.oldText === "string" && typeof c.newText === "string")
        .slice(0, 50) as { oldText: string; newText: string }[];
      if (!changes.length) return Response.json({ error: "No text changes to send." }, { status: 400 });
      return Response.json({ ok: true, ...(await applyTextChanges(id, changes)) });
    }

    const instruction = body.instruction?.trim().slice(0, 500);
    if (!instruction) return Response.json({ error: "Describe a change." }, { status: 400 });
    if (!body.selector) return Response.json({ error: "Select an element first." }, { status: 400 });
    await assertCredits(project.workspaceId, { userId: user.id, projectId: id });
    const r = await quickEdit({
      projectId: id,
      workspaceId: project.workspaceId,
      userId: user.id,
      instruction,
      element: { selector: body.selector, text: body.text ?? "" },
    });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof QuickEditError) {
      const status = e.code === "busy" ? 409 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    if (e instanceof InsufficientCredits || e instanceof SpendLimitReached) {
      return Response.json({ error: "You're out of credits or at a spending limit.", code: "credits" }, { status: 402 });
    }
    throw e;
  }
}

export const POST = route(POST_);
