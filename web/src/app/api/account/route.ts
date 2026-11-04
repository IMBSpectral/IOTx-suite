import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { route } from "@/lib/route";
import { cancelDeletion, DELETION_GRACE_DAYS, deletionImpact, scheduleDeletion } from "@/lib/account";
import { audit } from "@/lib/workspace-security";

async function currentToken() {
  const jar = await cookies();
  return jar.get("__Secure-authjs.session-token")?.value ?? jar.get("authjs.session-token")?.value ?? null;
}

/** Privacy settings: data use, signed-in sessions, and account deletion. */
async function GET_() {
  const user = await requireUser();
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: {
      email: true,
      improveForge: true,
      deletionScheduledAt: true,
      suggestions: true,
      sandboxDiagnostics: true,
      handle: true,
      name: true,
      profilePublic: true,
      linkedinUrl: true,
    },
  });
  const token = await currentToken();
  const sessions = await db.session.findMany({ where: { userId: user.id, expires: { gt: new Date() } }, orderBy: { expires: "desc" } });
  const devices = await db.deviceAuth.findMany({ where: { userId: user.id, status: "consumed" }, select: { clientName: true, createdAt: true } });
  return Response.json({
    email: me.email,
    improveForge: me.improveForge,
    prefs: { suggestions: me.suggestions, sandboxDiagnostics: me.sandboxDiagnostics },
    profile: { handle: me.handle, name: me.name, public: me.profilePublic, linkedinUrl: me.linkedinUrl },
    deletionScheduledAt: me.deletionScheduledAt?.toISOString() ?? null,
    graceDays: DELETION_GRACE_DAYS,
    impact: await deletionImpact(user.id),
    sessions: sessions.map((s) => ({ id: s.id, current: s.sessionToken === token, expires: s.expires.toISOString() })),
    devices: devices.map((d) => ({ name: d.clientName, at: d.createdAt.toISOString() })),
  });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    on?: boolean;
    confirm?: string;
    id?: string;
    suggestions?: string;
    handle?: string;
    public?: boolean;
    linkedinUrl?: string | null;
  };
  switch (body.action) {
    case "improveForge":
      await db.user.update({ where: { id: user.id }, data: { improveForge: !!body.on } });
      return Response.json({ ok: true });
    case "prefs": {
      const data: { suggestions?: string; sandboxDiagnostics?: boolean } = {};
      if (body.suggestions !== undefined) {
        if (!["all", "first", "off"].includes(body.suggestions)) return Response.json({ error: "Choose all, first or off." }, { status: 400 });
        data.suggestions = body.suggestions;
      }
      if (typeof body.on === "boolean") data.sandboxDiagnostics = body.on;
      await db.user.update({ where: { id: user.id }, data });
      return Response.json({ ok: true });
    }
    case "profile": {
      const data: { handle?: string | null; profilePublic?: boolean; linkedinUrl?: string | null } = {};
      if (body.handle !== undefined) {
        const h = body.handle.trim().replace(/^@/, "").toLowerCase();
        if (h && !/^[a-z0-9][a-z0-9_-]{2,29}$/.test(h)) {
          return Response.json({ error: "Usernames are 3–30 letters, numbers, - or _." }, { status: 400 });
        }
        if (h && (await db.user.count({ where: { handle: h, NOT: { id: user.id } } }))) {
          return Response.json({ error: `@${h} is taken.` }, { status: 409 });
        }
        data.handle = h || null;
      }
      if (typeof body.public === "boolean") data.profilePublic = body.public;
      if (body.linkedinUrl !== undefined) {
        const u = (body.linkedinUrl ?? "").trim();
        if (u && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]{2,100}\/?$/.test(u)) {
          return Response.json({ error: "Use your LinkedIn profile address, like https://www.linkedin.com/in/your-name." }, { status: 400 });
        }
        data.linkedinUrl = u || null;
      }
      await db.user.update({ where: { id: user.id }, data });
      return Response.json({ ok: true });
    }
    case "scheduleDeletion": {
      const me = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } });
      if ((body.confirm ?? "").trim().toLowerCase() !== me.email.toLowerCase()) {
        return Response.json({ error: "Type your email address to confirm." }, { status: 400 });
      }
      const at = await scheduleDeletion(user.id);
      return Response.json({ ok: true, deletionScheduledAt: at.toISOString() });
    }
    case "cancelDeletion":
      await cancelDeletion(user.id);
      return Response.json({ ok: true });
    case "revokeSession":
    case "revokeOthers": {
      const token = await currentToken();
      const where =
        body.action === "revokeSession"
          ? { id: body.id ?? "", userId: user.id, NOT: { sessionToken: token ?? "" } }
          : { userId: user.id, NOT: { sessionToken: token ?? "" } };
      const { count } = await db.session.deleteMany({ where });
      if (count) {
        const ws = await currentWorkspace(user.id);
        await audit(ws.id, user.id, "session.revoked", `Signed out ${count} other session${count === 1 ? "" : "s"}`);
      }
      return Response.json({ ok: true, revoked: count });
    }
    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
