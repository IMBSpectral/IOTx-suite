import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { db } from "@/lib/db";
import { ensureMainSnapshot, readSiteFile } from "@/lib/publish";
import { linkStatus, verifyPassword } from "@/lib/sharing";
import { notifyComment } from "@/lib/comments";
import { GUEST_COMMENT_SCRIPT } from "@/lib/guest-comments";
import { signSiteToken, verifySiteToken } from "@/lib/site-auth";
import { previewViewerAllowed } from "@/lib/workspace-security";

/**
 * Serves a preview link at preview--<token>.localhost (rewritten here by
 * proxy.ts): the current accepted version of the project, to anyone holding
 * the link, until it expires or is revoked. Password links unlock with a
 * cookie scoped to the link's own host.
 */
type Ctx = { params: Promise<{ token: string; path?: string[] }> };

const COOKIE = "forge_preview_link";
/** Who opened a "Sign-in only" link (the workspace's preview-link policy). */
const VIEWER_COOKIE = "forge_preview_viewer";
const EDITOR = process.env.EDITOR_ORIGIN ?? "http://localhost:3000";

function secret() {
  const s = process.env.PREVIEW_TOKEN_SECRET;
  if (!s) throw new Error("PREVIEW_TOKEN_SECRET is not set");
  return new TextEncoder().encode(s);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function page(status: number, title: string, body: string, extra = "") {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
      `<body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:system-ui,sans-serif;background:#fafaf9;color:#1c1917">` +
      `<div style="text-align:center;max-width:360px;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">${esc(title)}</h1><p style="color:#78716c;margin:0 0 16px">${body}</p>${extra}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function unlockForm(error?: string) {
  return page(
    error ? 401 : 200,
    "This preview is password protected",
    "Enter the password you were given to view it.",
    `<form method="post" action="/__forge/unlock" style="display:flex;gap:8px">` +
      `<input type="password" name="password" required autofocus aria-label="Password" style="flex:1;padding:8px 10px;border:1px solid #d6d3d1;border-radius:8px">` +
      `<button style="padding:8px 14px;border:0;border-radius:8px;background:#1c1917;color:#fff">View</button></form>` +
      (error ? `<p role="alert" style="color:#dc2626;font-size:13px;margin-top:10px">${esc(error)}</p>` : ""),
  );
}

async function load(token: string) {
  const link = await db.previewLink.findUnique({
    where: { token },
    include: { project: { select: { id: true, deletedAt: true, workspace: { select: { id: true, previewSharing: true, verifiedDomains: true } } } } },
  });
  if (!link || link.project.deletedAt) return { error: page(404, "Link not found", "This preview link doesn't exist.") };
  const status = linkStatus(link);
  if (status === "revoked") return { error: page(410, "Link revoked", "The owner turned this preview link off.") };
  if (status === "expired") return { error: page(410, "Link expired", "Ask the owner for a new preview link.") };
  return { link };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>["link"]>;

/**
 * With the workspace on "Sign-in only", the visitor must be signed in as a
 * member or from a verified domain: checked on every request, so changing the
 * policy applies to links that already exist.
 */
async function signedInViewer(link: Loaded, token: string) {
  if (link.project.workspace.previewSharing !== "signin") return true;
  const t = (await cookies()).get(VIEWER_COOKIE)?.value;
  const uid = t ? await verifySiteToken(t, `preview--${token}`) : null;
  return !!uid && (await previewViewerAllowed(link.project.workspace, uid));
}

const toSignIn = (token: string, next: string) =>
  new Response(null, { status: 302, headers: { location: `${EDITOR}/api/preview-auth?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}` } });

async function unlocked(linkId: string) {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: "preview-link" });
    return payload.sub === linkId;
  } catch {
    return false;
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const { token, path = [] } = await params;
  const rel = path.join("/");
  if (rel === "__forge/comments") return guestComment(req, token);
  if (rel !== "__forge/unlock") return new Response("Method not allowed", { status: 405 });
  const { link, error } = await load(token);
  if (!link) return error;
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  if (!link.passwordHash || !(await verifyPassword(password, link.passwordHash))) {
    return unlockForm("That password isn't right.");
  }
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(link.id)
    .setAudience("preview-link")
    .setExpirationTime("7d")
    .sign(secret());
  const res = new Response(null, { status: 303, headers: { location: "/" } });
  res.headers.append("set-cookie", `${COOKIE}=${jwt}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  return res;
}

/** A guest's comment through a link that allows comments; lands in the project's threads. */
async function guestComment(req: Request, token: string) {
  const { link } = await load(token);
  if (!link) return Response.json({ error: "Link not active" }, { status: 410 });
  if (!link.allowComments) return Response.json({ error: "Comments are off for this link" }, { status: 403 });
  if (link.passwordHash && !(await unlocked(link.id))) return Response.json({ error: "Locked" }, { status: 401 });
  if (!(await signedInViewer(link, token))) return Response.json({ error: "Sign in to comment" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const name = str(b.name, 60);
  const body = str(b.body, 2000);
  if (!name || !body) return Response.json({ error: "Add your name and a comment." }, { status: 400 });
  // Guests can't flood a project.
  const recent = await db.comment.count({
    where: { previewLinkId: link.id, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } },
  });
  if (recent >= 30) return Response.json({ error: "Too many comments, try again later." }, { status: 429 });
  const c = await db.comment.create({
    data: {
      projectId: link.projectId,
      previewLinkId: link.id,
      guestName: name,
      body,
      locator: str(b.locator, 1000) || null,
      selector: str(b.selector, 300) || null,
      elementText: str(b.text, 200) || null,
    },
  });
  const project = await db.project.findUnique({ where: { id: link.projectId } });
  if (project) {
    await notifyComment({ project, authorId: null, authorName: `${name} (guest)`, body, threadId: c.id });
  }
  return Response.json({ ok: true }, { status: 201 });
}

export async function GET(req: Request, { params }: Ctx) {
  const { token, path = [] } = await params;
  const rel = path.join("/");
  const { link, error } = await load(token);
  if (!link) return error;

  // Completing the sign-in handshake (see /api/preview-auth).
  if (rel === "__forge/auth") {
    const uid = await verifySiteToken(new URL(req.url).searchParams.get("token") ?? "", `preview--${token}`);
    if (!uid) return page(401, "Link expired", "Open the preview link again.");
    const long = await signSiteToken(`preview--${token}`, uid, "1d");
    const next = new URL(req.url).searchParams.get("next") ?? "/";
    const res = new Response(null, { status: 302, headers: { location: next.startsWith("/") ? next : "/" } });
    res.headers.append("set-cookie", `${VIEWER_COOKIE}=${long}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    return res;
  }
  if (!(await signedInViewer(link, token))) {
    const url = new URL(req.url);
    return toSignIn(token, url.pathname.replace(/^\/shared\/[^/]+/, "") + url.search || "/");
  }
  if (link.passwordHash && !(await unlocked(link.id))) return unlockForm();

  if (rel === "__forge/comments.js") {
    if (!link.allowComments) return new Response("Not found", { status: 404 });
    return new Response(GUEST_COMMENT_SCRIPT, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const snap = await ensureMainSnapshot(link.projectId);
  if (!snap.ok) return page(503, "Preview unavailable", "The app couldn't be built right now. Try again shortly.");

  if (rel && rel !== "index.html") {
    const file = await readSiteFile(link.projectId, snap.sha, rel);
    if (file) {
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          "content-type": file.type,
          "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (/\.[a-z0-9]{1,5}$/i.test(rel)) return new Response("Not found", { status: 404 });
  }

  const index = await readSiteFile(link.projectId, snap.sha, "index.html");
  if (!index) return page(500, "Build missing", "Try again shortly.");
  void db.previewLink
    .update({ where: { id: link.id }, data: { views: { increment: 1 }, lastViewedAt: new Date() } })
    .catch(() => undefined);
  // Previews are not for search engines.
  const html = index.bytes
    .toString("utf8")
    .replace("<head>", '<head><meta name="robots" content="noindex">')
    .replace("</body>", link.allowComments ? '<script src="/__forge/comments.js" defer></script></body>' : "</body>");
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" },
  });
}
