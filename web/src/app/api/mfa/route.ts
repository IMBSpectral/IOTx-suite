import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { requireUser } from "@/lib/workspace";
import { route } from "@/lib/route";
import { beginSetup, confirmSetup, disable, MfaError, mfaStatus, regenerateRecovery, verifySession } from "@/lib/mfa";
import { sessionTokenFrom } from "@/lib/session-cookie";

/**
 * Two-step verification.
 *   GET                                 -> { enabled, enabledAt, recoveryLeft }
 *   POST { action: "setup" }            -> { secret, otpauth, qr }        (start; not active yet)
 *   POST { action: "enable", code }     -> { recoveryCodes }              (first code turns it on)
 *   POST { action: "disable", code }    -> { ok }                         (a code or a recovery code)
 *   POST { action: "recovery", code }   -> { recoveryCodes }              (new set; old ones stop working)
 *   POST { action: "verify", code }     -> { ok }   the sign-in step, for a session waiting on its code
 */
async function token() {
  const jar = await cookies();
  return sessionTokenFrom(jar.getAll().map((c) => `${c.name}=${c.value}`).join("; "));
}

async function GET_() {
  const user = await requireUser();
  return Response.json(await mfaStatus(user.id));
}

async function POST_(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; code?: string };
  const code = String(body.code ?? "").trim().slice(0, 40);
  try {
    if (body.action === "verify") {
      const session = (await auth()) as unknown as { mfaPending?: boolean; mfaUserId?: string } | null;
      const t = await token();
      if (!session?.mfaPending || !session.mfaUserId || !t) return Response.json({ error: "Nothing to verify. Sign in again." }, { status: 400 });
      await verifySession(session.mfaUserId, t, code);
      return Response.json({ ok: true });
    }
    const user = await requireUser();
    switch (body.action) {
      case "setup":
        return Response.json(await beginSetup(user.id));
      case "enable": {
        const recoveryCodes = await confirmSetup(user.id, code, await token());
        return Response.json({ recoveryCodes });
      }
      case "disable":
        await disable(user.id, code);
        return Response.json({ ok: true });
      case "recovery":
        return Response.json({ recoveryCodes: await regenerateRecovery(user.id, code) });
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MfaError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
