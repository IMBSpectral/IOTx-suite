import { requireProjectPerm } from "@/lib/iotx/permissions";
import { requireUser, requireProject } from "@/lib/workspace";
import { route } from "@/lib/route";
import { ensureSandbox } from "@/lib/sandbox";
import { PtyError, closePty, openPty, resizePty, subscribePty, writePty } from "@/lib/pty";

export const maxDuration = 3600;

type Ctx = { params: Promise<{ id: string }> };

/**
 * The editor's terminal, a real shell in the project's container.
 * POST {action:"open", cols, rows} starts one; "input", "resize" and "close"
 * drive it. GET ?session=<id> streams its output as server-sent events
 * ({type:"data", b64}, then {type:"exit"}).
 */
async function GET_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.code.edit");
  const session = new URL(req.url).searchParams.get("session") ?? "";

  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          stop();
        }
      };
      try {
        stop = subscribePty(id, session, user.id, (e) => {
          if (e.type === "data") send({ type: "data", b64: e.data.toString("base64") });
          else {
            send({ type: "exit" });
            stop();
            try {
              controller.close();
            } catch {}
          }
        });
      } catch {
        send({ type: "exit" });
        controller.close();
      }
      req.signal.addEventListener("abort", () => stop());
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

async function POST_(req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await requireUser();
  await requireProject(user.id, id, "edit");
  await requireProjectPerm(user.id, id, "builder.code.edit");
  const b = (await req.json().catch(() => ({}))) as { action?: string; session?: string; data?: string; cols?: number; rows?: number };
  try {
    if (b.action === "open") {
      const state = await ensureSandbox(id);
      if (state.status !== "ready") return Response.json({ error: "The project's container isn't running yet. Start the preview first." }, { status: 409 });
      return Response.json({ session: await openPty(id, user.id, b.cols ?? 80, b.rows ?? 24) });
    }
    const session = b.session ?? "";
    if (b.action === "input") writePty(id, session, user.id, String(b.data ?? ""));
    else if (b.action === "resize") await resizePty(id, session, user.id, b.cols ?? 80, b.rows ?? 24);
    else if (b.action === "close") closePty(id, session, user.id);
    else return Response.json({ error: "Unknown action" }, { status: 400 });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof PtyError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
