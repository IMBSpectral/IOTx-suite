import { db } from "@/lib/db";
import { requireUser, currentWorkspace, requireRole } from "@/lib/workspace";
import { route } from "@/lib/route";
import { CHECKS } from "@/lib/scan";
import {
  addDomain,
  audit,
  auditLog,
  buildDigest,
  digestSummary,
  domainsOf,
  removeDomain,
  rulesOf,
  SecurityError,
  sendDigest,
  txtRecord,
  verifyDomain,
} from "@/lib/workspace-security";
import { assertNotEnforced, enforcedKeys, OrgError } from "@/lib/orgs";

/** Workspace security settings: digest, scan rules, verified domains, sharing policy, audit trail. */
async function GET_() {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const full = await db.workspace.findUniqueOrThrow({ where: { id: ws.id } });
  const digest = await buildDigest(ws.id);
  return Response.json({
    digest: { on: full.securityDigest, lastSentAt: full.securityDigestAt?.toISOString() ?? null, preview: digest, summary: digestSummary(digest) },
    rules: rulesOf(full),
    checks: CHECKS.map((c) => ({ id: c.id, title: c.title, severity: c.severity, category: c.category })),
    domains: domainsOf(full).map((d) => ({ domain: d.domain, verified: !!d.verifiedAt, record: txtRecord(d.token) })),
    inviteVerifiedOnly: full.inviteVerifiedOnly,
    domainJoin: full.domainJoin,
    previewSharing: full.previewSharing,
    cloudAutoApprove: full.cloudAutoApprove,
    enforcedByOrg: await enforcedKeys(ws.id),
    log: await auditLog(ws.id, 50),
  });
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requireRole(user.id, ws.id, ["OWNER", "ADMIN"]);
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    on?: boolean;
    domain?: string;
    disabledChecks?: string[];
    blockPublishOn?: string;
    previewSharing?: string;
    cloudAutoApprove?: boolean;
    domainJoin?: string;
  };
  try {
    switch (body.action) {
      case "digest":
        await db.workspace.update({ where: { id: ws.id }, data: { securityDigest: !!body.on } });
        await audit(ws.id, user.id, "workspace.settings", `Security digest ${body.on ? "on" : "off"}`);
        return Response.json({ ok: true });
      case "sendDigest": {
        const d = await sendDigest(ws.id);
        return Response.json({ ok: true, summary: digestSummary(d) });
      }
      case "rules": {
        const rules = rulesOf({ securityRules: { disabledChecks: body.disabledChecks ?? [], blockPublishOn: body.blockPublishOn } });
        await db.workspace.update({ where: { id: ws.id }, data: { securityRules: rules } });
        await audit(
          ws.id,
          user.id,
          "rules.changed",
          `Publishing blocked on ${rules.blockPublishOn} and above; ${rules.disabledChecks.length} check${rules.disabledChecks.length === 1 ? "" : "s"} off workspace-wide`,
        );
        return Response.json({ ok: true, rules });
      }
      case "addDomain": {
        const d = await addDomain(ws.id, body.domain ?? "");
        await audit(ws.id, user.id, "domain.added", `Added ${d.domain}`);
        return Response.json({ ok: true, domain: d.domain, record: txtRecord(d.token) }, { status: 201 });
      }
      case "verifyDomain": {
        const r = await verifyDomain(ws.id, body.domain ?? "");
        if (r.verified) await audit(ws.id, user.id, "domain.verified", `Verified ${r.entry.domain}`);
        return Response.json({
          ok: true,
          verified: r.verified,
          ...(r.verified ? {} : { error: `No TXT record "${txtRecord(r.entry.token)}" found on ${r.entry.domain} yet. DNS changes can take a while.` }),
        });
      }
      case "removeDomain":
        await removeDomain(ws.id, body.domain ?? "");
        await audit(ws.id, user.id, "domain.removed", `Removed ${body.domain}`);
        return Response.json({ ok: true });
      case "inviteVerifiedOnly": {
        const full = await db.workspace.findUniqueOrThrow({ where: { id: ws.id } });
        if (body.on && !domainsOf(full).some((d) => d.verifiedAt)) {
          return Response.json({ error: "Verify a domain first." }, { status: 400 });
        }
        await db.workspace.update({ where: { id: ws.id }, data: { inviteVerifiedOnly: !!body.on } });
        await audit(ws.id, user.id, "workspace.settings", `Invites limited to verified domains: ${body.on ? "on" : "off"}`);
        return Response.json({ ok: true });
      }
      case "domainJoin": {
        const v = body.domainJoin;
        if (v !== "off" && v !== "request" && v !== "auto") return Response.json({ error: "Choose off, request or auto." }, { status: 400 });
        const full = await db.workspace.findUniqueOrThrow({ where: { id: ws.id } });
        if (v !== "off" && !domainsOf(full).some((d) => d.verifiedAt)) return Response.json({ error: "Verify a domain first." }, { status: 400 });
        await db.workspace.update({ where: { id: ws.id }, data: { domainJoin: v } });
        const what = v === "auto" ? "join automatically" : v === "request" ? "can ask to join" : "can't join on their own";
        await audit(ws.id, user.id, "workspace.settings", `People with a verified-domain email ${what}`);
        return Response.json({ ok: true });
      }
      case "cloudAutoApprove": {
        await assertNotEnforced(ws.id, "cloudAutoApprove");
        const v = body.cloudAutoApprove === true;
        await db.workspace.update({ where: { id: ws.id }, data: { cloudAutoApprove: v } });
        await audit(ws.id, user.id, "workspace.settings", `Agent Cloud setup: ${v ? "automatic" : "asks for approval"}`);
        return Response.json({ ok: true });
      }
      case "previewSharing": {
        await assertNotEnforced(ws.id, "previewSharing");
        const v = body.previewSharing;
        if (v !== "anyone" && v !== "password" && v !== "signin" && v !== "off") {
          return Response.json({ error: "Choose anyone, password, signin or off." }, { status: 400 });
        }
        await db.workspace.update({ where: { id: ws.id }, data: { previewSharing: v } });
        await audit(ws.id, user.id, "workspace.settings", `Preview links: ${v === "anyone" ? "anyone with the link" : v === "password" ? "password required" : v === "signin" ? "sign-in only" : "off"}`);
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof OrgError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof SecurityError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export const GET = route(GET_);
export const POST = route(POST_);
