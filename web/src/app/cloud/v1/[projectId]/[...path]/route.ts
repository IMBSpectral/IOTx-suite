import { appUser, CloudError, getCloud, rest, signIn, signUp } from "@/lib/cloud";
import { getBrand } from "@/lib/brand";
import { aiChat, gate, recordError, sendEmail } from "@/lib/cloud-ops";
import { dataScope } from "@/lib/draft-data";
import { handleMcp } from "@/lib/app-mcp";
import { GuardError, guardLogin, guardSignup, loginFailed, loginSucceeded } from "@/lib/auth-guard";
import { logRequest } from "@/lib/cloud-admin";
import { isSqlError } from "@/lib/cloud-db";
import { invokeFunction } from "@/lib/cloud-functions";
import { getRun, sendEvent, startRun } from "@/lib/cloud-workflows";
import { checkPasswordAuth, sendSignInCode, verifySignInCode } from "@/lib/cloud-auth";
import { exchangeCode } from "@/lib/forge-identity";
import { db } from "@/lib/db";
import { buckets, checkSignature, listFiles, putFile, readFile, removeFile, signedUrl } from "@/lib/cloud-storage";

/**
 * Forge Cloud's app-facing API. Called from the user's app (preview or
 * published site, any origin), so it uses no cookies: the anon key names the
 * project and a Bearer token names the app's signed-in user.
 */
type Ctx = { params: Promise<{ projectId: string; path: string[] }> };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "apikey, authorization, content-type, x-upsert, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "600",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

function fileResponse(type: string, bytes: Uint8Array, cache: string) {
  // Never let an uploaded HTML or SVG file run as a page on this origin.
  const inline = /^(image\/(png|jpe?g|gif|webp|avif)|video\/|audio\/|application\/pdf|text\/plain)/.test(type);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": inline ? type : "application/octet-stream",
      "content-disposition": inline ? "inline" : "attachment",
      "x-content-type-options": "nosniff",
      "cache-control": cache,
      ...CORS,
    },
  });
}

async function handle(req: Request, { params }: Ctx) {
  const { projectId, path } = await params;
  try {
    const cfg = await getCloud(projectId);
    if (!cfg?.enabled) return json({ error: `${getBrand().shortName} Cloud isn't enabled for this project.` }, 404);
    // The app's MCP server authenticates with its own token, not the anon key.
    if (path[0] === "mcp" && path.length === 1) {
      await gate(projectId, cfg);
      return handleMcp(projectId, req);
    }
    // Public-bucket files and signed links open without the anon key (plain <img src>).
    if (path[0] === "storage" && (path[1] === "public" || path[1] === "signed") && req.method === "GET" && path.length >= 4) {
      await gate(projectId, cfg);
      const [, kind, bucket, ...rest] = path;
      const p = rest.map(decodeURIComponent).join("/");
      const u = new URL(req.url);
      if (kind === "public" && buckets(cfg)[bucket]?.access !== "public") return json({ error: "File not found" }, 404);
      if (kind === "signed" && !checkSignature(cfg, bucket, p, u.searchParams.get("exp"), u.searchParams.get("sig"))) {
        return json({ error: "This link has expired or isn't valid." }, 403);
      }
      const { file, bytes } = await readFile(projectId, cfg, bucket, p, null, { signed: kind === "signed" });
      return fileResponse(file.content_type, bytes, kind === "public" ? "public, max-age=60" : "private, max-age=60");
    }
    if (req.headers.get("apikey") !== cfg.anonKey) return json({ error: "Missing or wrong apikey." }, 401);
    // Paused, idle or overloaded backends stop here; everything else is counted.
    await gate(projectId, cfg);
    // The preview of a draft with its own backend reads and writes that draft's data.
    const data = await dataScope(projectId, req.headers.get("origin"));

    const [area, name] = path;

    // Server functions: /functions/<name>, any method; the handler sees the app user.
    if (area === "functions" && name && path.length === 2) {
      const user = await appUser(cfg, req.headers.get("authorization"));
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        if (k !== "apikey" && k !== "cookie") headers[k] = v;
      });
      const body = req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(await req.arrayBuffer());
      const res = await invokeFunction(projectId, cfg, name, { method: req.method, url: req.url, headers, body }, user, "http");
      const out = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) out.set(k, v);
      out.delete("content-length");
      out.delete("set-cookie");
      return new Response(new Uint8Array(res.body), { status: res.status, headers: out });
    }

    // Workflows: POST /workflows/<name>/runs {input} · GET /workflows/runs/<id> · POST /workflows/runs/<id>/events {event, data}
    if (area === "workflows") {
      const [, a, b, c] = path;
      if (a === "runs" && b && !c && req.method === "GET") return json(await getRun(data, b));
      if (a === "runs" && b && c === "events" && req.method === "POST") {
        const body = ((await req.json().catch(() => null)) ?? {}) as { event?: string; data?: unknown };
        return json(await sendEvent(projectId, data, b, String(body.event ?? ""), body.data));
      }
      if (a && b === "runs" && !c && req.method === "POST") {
        const body = ((await req.json().catch(() => null)) ?? {}) as { input?: unknown };
        return json(await startRun(projectId, data, a, body.input ?? {}), 201);
      }
      return json({ error: "Not found" }, 404);
    }

    // Storage: /storage/object/<bucket>/<path> (GET, PUT/POST raw body, DELETE),
    // /storage/list/<bucket>?prefix=, /storage/sign/<bucket>/<path> (POST {expiresIn}).
    if (area === "storage" && path.length >= 3) {
      const user = await appUser(cfg, req.headers.get("authorization"));
      const [, kind, bucket, ...rest] = path;
      const p = rest.map(decodeURIComponent).join("/");
      if (kind === "list" && req.method === "GET") {
        const q = new URL(req.url).searchParams;
        return json(await listFiles(projectId, cfg, bucket, user, { prefix: q.get("prefix") ?? "", limit: Number(q.get("limit") ?? 100), offset: Number(q.get("offset") ?? 0) }));
      }
      if (kind === "sign" && req.method === "POST") {
        const b = ((await req.json().catch(() => null)) ?? {}) as { expiresIn?: number };
        return json(await signedUrl(projectId, cfg, bucket, p, user, Number(b.expiresIn ?? 3600)));
      }
      if (kind === "object") {
        if (req.method === "GET") {
          const { file, bytes } = await readFile(projectId, cfg, bucket, p, user);
          return fileResponse(file.content_type, bytes, "private, max-age=0");
        }
        if (req.method === "PUT" || req.method === "POST") {
          const bytes = new Uint8Array(await req.arrayBuffer());
          return json(await putFile(projectId, cfg, bucket, p, bytes, req.headers.get("content-type") ?? "", user), 201);
        }
        if (req.method === "DELETE") return json(await removeFile(projectId, cfg, bucket, p, user));
      }
      return json({ error: "Not found" }, 404);
    }

    const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => null) : null;

    if (area === "auth") {
      if (req.method === "POST" && name === "signup") {
        const b = (body ?? {}) as { email?: string; password?: string };
        checkPasswordAuth(cfg, b.email ?? "", "signup");
        guardSignup(projectId, req);
        return json(await signUp(data, cfg, b.email ?? "", b.password ?? ""), 201);
      }
      if (req.method === "POST" && name === "login") {
        const b = (body ?? {}) as { email?: string; password?: string };
        checkPasswordAuth(cfg, b.email ?? "", "login");
        guardLogin(projectId, req, b.email ?? "");
        try {
          const session = await signIn(data, cfg, b.email ?? "", b.password ?? "");
          loginSucceeded(projectId, b.email ?? "");
          return json(session);
        } catch (e) {
          if (e instanceof CloudError && e.status === 401) loginFailed(projectId, req, b.email ?? "");
          throw e;
        }
      }
      // Sign-in by emailed code: /auth/otp {email}, then /auth/verify {email, code}.
      if (req.method === "POST" && name === "otp") {
        const b = (body ?? {}) as { email?: string };
        guardSignup(projectId, req);
        const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true } });
        return json(await sendSignInCode(data, cfg, b.email ?? "", p?.name ?? "the app"));
      }
      if (req.method === "POST" && name === "verify") {
        const b = (body ?? {}) as { email?: string; code?: string };
        guardLogin(projectId, req, b.email ?? "");
        try {
          const session = await verifySignInCode(data, cfg, b.email ?? "", b.code ?? "");
          loginSucceeded(projectId, b.email ?? "");
          return json(session);
        } catch (e) {
          if (e instanceof CloudError && e.status === 401) loginFailed(projectId, req, b.email ?? "");
          throw e;
        }
      }
      // "Continue with Forge": trade the code from Forge's consent page for a session.
      if (req.method === "POST" && name === "forge") {
        const b = (body ?? {}) as { code?: string };
        guardLogin(projectId, req, "forge");
        return json(await exchangeCode(data, cfg, b.code ?? "", req.headers.get("origin")));
      }
      // "Continue with Google": off to Google; the platform's callback hands the app a one-time code.
      if (req.method === "GET" && name === "google") {
        const q = new URL(req.url).searchParams;
        const { authSettings } = await import("@/lib/cloud-auth");
        if (!authSettings(cfg).google) return json({ error: "This app doesn't offer Continue with Google." }, 403);
        const { allowedRedirect } = await import("@/lib/forge-identity");
        const back = await allowedRedirect(projectId, q.get("redirect_uri") ?? "");
        if (!back) return json({ error: "That return address doesn't belong to this app." }, 400);
        const { connectUrl, googleConfigured } = await import("@/lib/google");
        if (!googleConfigured()) return json({ error: "Google sign-in isn't set up on this server." }, 503);
        const state = (q.get("state") ?? "").slice(0, 100);
        return Response.redirect(
          connectUrl("app", null, "/", { scopes: ["openid", "email", "profile"], pickAccount: true, extra: { k: "app", p: projectId, r: back.toString(), st: state } }),
          302,
        );
      }
      if (req.method === "GET" && name === "user") {
        const user = await appUser(cfg, req.headers.get("authorization"));
        return user ? json({ user }) : json({ error: "Not signed in." }, 401);
      }
      return json({ error: "Not found" }, 404);
    }

    if (area === "ai" && name === "chat" && req.method === "POST" && path.length === 2) {
      return json(await aiChat(projectId, cfg, body));
    }

    if (area === "email" && name === "send" && req.method === "POST" && path.length === 2) {
      const user = await appUser(cfg, req.headers.get("authorization"));
      return json(await sendEmail(projectId, cfg, body, user), 201);
    }

    if (area === "rest" && name && path.length === 2) {
      const user = await appUser(cfg, req.headers.get("authorization"));
      const result = await rest(data, cfg, req.method, name, new URL(req.url).searchParams, body, user);
      return json(result, req.method === "POST" ? 201 : 200);
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof GuardError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status,
        headers: { "content-type": "application/json", ...CORS, ...(e.retryAfter ? { "retry-after": String(e.retryAfter) } : {}) },
      });
    }
    if (!(e instanceof CloudError && e.status === 503)) recordError(projectId);
    if (e instanceof CloudError) return json({ error: e.message }, e.status);
    // Database errors (SQLite constraint errors, Postgres data errors) are the app's mistakes, not ours.
    if (e instanceof Error && (/constraint|SQLITE|no such|datatype/i.test(e.message) || isSqlError(e))) return json({ error: e.message }, 400);
    throw e;
  }
}

/** Every request lands in the project's request log (Cloud tab → Logs). */
async function logged(req: Request, ctx: Ctx) {
  const started = Date.now();
  const res = await handle(req, ctx);
  const { projectId, path } = await ctx.params;
  const cfg = await getCloud(projectId).catch(() => null);
  if (cfg?.enabled) {
    const user = await appUser(cfg, req.headers.get("authorization")).catch(() => null);
    const search = new URL(req.url).search;
    await logRequest(projectId, { method: req.method, path: `/${path.join("/")}${search}`, status: res.status, ms: Date.now() - started, user_id: user?.id ?? null });
  }
  return res;
}

export const GET = logged;
export const POST = logged;
export const PUT = logged;
export const PATCH = logged;
export const DELETE = logged;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
