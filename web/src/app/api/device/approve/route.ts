import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { decide, DeviceAuthError, findPending } from "@/lib/device-auth";
import { audit } from "@/lib/workspace-security";

/** Which device is asking for this code (signed-in only). */
async function GET_(req: Request) {
  await requireUser();
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const pending = await findPending(code);
  if (!pending) return Response.json({ error: "That code has expired or was already used. Start again on the device." }, { status: 404 });
  return Response.json(pending);
}

/** Approve or deny a device sign-in. */
async function POST_(req: Request) {
  const user = await requireUser();
  const { code, approve } = (await req.json().catch(() => ({}))) as { code?: string; approve?: boolean };
  try {
    const r = await decide(code ?? "", user.id, !!approve);
    if (r.approved) {
      const ws = await currentWorkspace(user.id);
      await audit(ws.id, user.id, "device.approved", `Approved a sign-in for ${r.clientName}`);
    }
    return Response.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof DeviceAuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
