import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { sandboxState, touchSandbox } from "./sandbox";

/**
 * Live previews on a server. A project's dev server listens on a loopback port
 * (127.0.0.1:<port>), which a visitor's browser can't reach. With
 * SANDBOX_PUBLIC_HOST set (e.g. imbspectral.online), each preview gets its own
 * origin, https://sbx-<projectId>.<host>, which Caddy sends to this proxy
 * (127.0.0.1:SANDBOX_PROXY_PORT, default 3011). The proxy forwards requests
 * and the HMR WebSocket to the project's port.
 *
 * Its own origin keeps the generated (untrusted) app away from the editor's
 * cookies. Access: the editor's sandbox route (which checks project access)
 * hands out the URL with a signed pass (?__sbx=…, valid for a few hours); the
 * proxy turns it into a cookie on that preview origin and drops it from the
 * address. Without a valid pass the preview isn't served. Locally (no
 * SANDBOX_PUBLIC_HOST) previews keep using http://127.0.0.1:<port>.
 */

const HOST = (process.env.SANDBOX_PUBLIC_HOST ?? "").toLowerCase();
const PORT = Number(process.env.SANDBOX_PROXY_PORT) || 3011;
const SECRET = () => process.env.AUTH_SECRET ?? process.env.PREVIEW_TOKEN_SECRET ?? "";
const WINDOW_MS = 6 * 3600_000;
const COOKIE = "sbx_pass";

function sign(projectId: string, exp: number) {
  return `${exp}.${crypto.createHmac("sha256", SECRET()).update(`sbx:${projectId}:${exp}`).digest("base64url")}`;
}
function valid(projectId: string, pass: string | null | undefined) {
  if (!pass || !SECRET()) return false;
  const [exp] = pass.split(".");
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(projectId, Number(exp)));
  const got = Buffer.from(pass);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** The address the editor gives the preview iframe (stable for hours, so the iframe isn't reloaded on every poll). */
export function previewUrl(projectId: string, port: number) {
  if (!HOST) return `http://127.0.0.1:${port}`;
  const exp = (Math.floor(Date.now() / WINDOW_MS) + 2) * WINDOW_MS;
  return `https://sbx-${projectId}.${HOST}/?__sbx=${encodeURIComponent(sign(projectId, exp))}`;
}

/** The project a preview host belongs to (for the certificate check too). */
export function previewProject(host: string) {
  const h = host.toLowerCase().split(":")[0];
  if (!HOST || !h.endsWith(`.${HOST}`)) return null;
  return /^sbx-([0-9a-f-]{36})$/.exec(h.slice(0, -HOST.length - 1))?.[1] ?? null;
}

const cookieOf = (raw: string | undefined) => /(?:^|;\s*)sbx_pass=([^;]+)/.exec(raw ?? "")?.[1];

function deny(res: http.ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#555"><p>${text}</p>`);
}

type Target = { error: 404 | 503; projectId?: string } | { error?: undefined; projectId: string; port: number };
function target(req: http.IncomingMessage): Target {
  const projectId = previewProject(req.headers.host ?? "");
  if (!projectId) return { error: 404 };
  const state = sandboxState(projectId);
  if (state.status !== "ready") return { error: 503, projectId };
  return { projectId, port: state.port };
}

let started = false;

/** Starts the preview proxy once (only when SANDBOX_PUBLIC_HOST is set). */
export function ensurePreviewProxy() {
  if (started || !HOST) return;
  started = true;
  const server = http.createServer((req, res) => {
    const t = target(req);
    if (t.error) return deny(res, t.error, t.error === 503 ? "The preview is starting. It reloads by itself in a moment." : "Preview not found.");
    const url = new URL(req.url ?? "/", "http://x");
    const pass = url.searchParams.get("__sbx");
    if (pass) {
      if (!valid(t.projectId, pass)) return deny(res, 403, "This preview link has expired. Open the project again.");
      url.searchParams.delete("__sbx");
      res.writeHead(302, {
        location: `${url.pathname}${url.search}`,
        "set-cookie": `${COOKIE}=${encodeURIComponent(pass)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${WINDOW_MS / 1000 * 2}`,
        "cache-control": "no-store",
      });
      return res.end();
    }
    if (!valid(t.projectId, decodeURIComponent(cookieOf(req.headers.cookie) ?? ""))) return deny(res, 403, "Open this preview from the project in IOTx.");
    touchSandbox(t.projectId);
    const up = http.request(
      { host: "127.0.0.1", port: t.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${t.port}` } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => deny(res, 502, "The preview isn't answering. It restarts by itself; reload in a moment."));
    req.pipe(up);
  });
  // The dev server's live-reload WebSocket.
  server.on("upgrade", (req, socket, head) => {
    const t = target(req);
    if (t.error || !valid(t.projectId, decodeURIComponent(cookieOf(req.headers.cookie) ?? ""))) return socket.destroy();
    const up = net.connect(t.port, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries({ ...req.headers, host: `127.0.0.1:${t.port}` }).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)];
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  server.on("error", (e) => console.error("[preview proxy]", e));
  server.listen(PORT, "127.0.0.1", () => console.log(`[preview proxy] sbx-*.${HOST} on 127.0.0.1:${PORT}`));
}
