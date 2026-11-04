import { requireProjectPerm } from "@/lib/iotx/permissions";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { act, browserHistory, browserState, BrowserError, closeBrowser, handBack, openUrl, screenshot, takeOver } from "@/lib/cloud-browser";

type Ctx = { params: Promise<{ id: string }> };

/** State (?shot=1 for the live screenshot, ?history=1 for the audit history). */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "view");
  const q = new URL(req.url).searchParams;
  if (q.get("history") === "1") return Response.json({ history: await browserHistory(id) });
  if (q.get("shot") === "1") {
    try {
      return new Response(new Uint8Array(await screenshot(id)), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return Response.json(browserState(id));
}

/** takeover · handback · open {url} · click {x,y} · type {text} · press {key} · scroll {dy} · close */
async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.browser");
  const b = (await req.json().catch(() => ({}))) as { action?: string; url?: string; x?: number; y?: number; text?: string; key?: string; dy?: number };
  const who = user.email ?? "someone";
  try {
    switch (b.action) {
      case "takeover":
        await takeOver(id, who);
        break;
      case "handback":
        await handBack(id, who);
        break;
      case "open":
        return Response.json(await openUrl(id, project.workspaceId, b.url ?? "", who, false));
      case "click":
        return Response.json(await act(id, project.workspaceId, { kind: "click", x: Number(b.x), y: Number(b.y) }, who, false));
      case "type":
        return Response.json(await act(id, project.workspaceId, { kind: "type", text: String(b.text ?? "").slice(0, 5000) }, who, false));
      case "press":
        return Response.json(await act(id, project.workspaceId, { kind: "press", key: String(b.key ?? "") }, who, false));
      case "scroll":
        return Response.json(await act(id, project.workspaceId, { kind: "scroll", dy: Number(b.dy ?? 400) }, who, false));
      case "close":
        await closeBrowser(id, who);
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
    return Response.json({ ok: true, ...browserState(id) });
  } catch (e) {
    if (e instanceof BrowserError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
