import { requireProjectPerm } from "@/lib/iotx/permissions";
import { requireUser, requireProject } from "@/lib/workspace";
import {
  acceptDraft,
  revertDraft,
  discardDraft,
  renameDraft,
  markDraftSeen,
  checkoutDraft,
  revertBlockedReason,
  syncDraft,
} from "@/lib/drafts";
import { route } from "@/lib/route";
import { createDraftBackend, removeDraftBackend } from "@/lib/draft-data";

type Ctx = { params: Promise<{ id: string; draftId: string }> };

/**
 * Draft actions. Accept and revert are deliberately separate verbs rather than
 * a status field, because each has its own precondition and failure message.
 */
async function POST_(req: Request, { params }: Ctx) {
  const { id, draftId } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  // Changing a draft builds; marking it seen or looking at it does not.
  const peek = (await req.clone().json().catch(() => ({}))) as { action?: string };
  if (peek.action !== "seen" && peek.action !== "checkout") await requireProjectPerm(user.id, id, "builder.build");

  const { action, name, on } = await req.json().catch(() => ({ action: "" }));

  try {
    switch (action) {
      case "accept": {
        const d = await acceptDraft(id, draftId);
        return Response.json({ ok: true, draft: d });
      }
      case "sync": {
        const d = await syncDraft(id, draftId);
        return Response.json({ ok: true, draft: d });
      }
      case "revert": {
        const d = await revertDraft(id, draftId);
        return Response.json({ ok: true, draft: d });
      }
      case "discard": {
        const d = await discardDraft(id, draftId);
        return Response.json({ ok: true, draft: d });
      }
      case "rename": {
        const d = await renameDraft(draftId, String(name ?? ""));
        return Response.json({ ok: true, draft: d });
      }
      case "checkout": {
        // "main" is not a draft: it means show the accepted project.
        if (draftId === "main") {
          return Response.json({ ok: true, ref: await checkoutDraft(id, null) });
        }
        const ref = await checkoutDraft(id, draftId);
        await markDraftSeen(draftId, user.id);
        return Response.json({ ok: true, ref });
      }
      case "backend": {
        // A draft's own Cloud data: on (copy the schema, add example rows), refresh, or off.
        if (on === false) {
          await removeDraftBackend(id, draftId);
          return Response.json({ ok: true, ownBackend: false });
        }
        const r = await createDraftBackend(id, draftId);
        return Response.json({ ok: true, ownBackend: true, tables: r.tables });
      }
      case "seen": {
        await markDraftSeen(draftId, user.id);
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    // These failures are expected preconditions, not server faults: the reason
    // is what the UI shows the user.
    return Response.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 409 },
    );
  }
}

async function GET_(_req: Request, { params }: Ctx) {
  const { id, draftId } = await params;
  const user = await requireUser();
  await requireProject(user.id, id);
  return Response.json({ revertBlockedReason: await revertBlockedReason(id, draftId) });
}

export const GET = route(GET_);
export const POST = route(POST_);
