/**
 * The live-preview proxy (lib/sandbox-proxy.ts) on its own: a fake dev server
 * on a loopback port, the proxy in front of it, and requests sent with the
 * preview host sbx-<projectId>.<host>. Checks the signed pass, the cookie, the
 * forwarding of pages and the HMR WebSocket upgrade, and refusals.
 *   npx tsx scripts/test-preview-proxy.mts
 */
import http from "node:http";
import net from "node:net";

process.env.SANDBOX_PUBLIC_HOST = "preview.test";
process.env.SANDBOX_PROXY_PORT = "3911";
process.env.AUTH_SECRET ??= "test-secret-for-preview-proxy";
const { ensurePreviewProxy, previewUrl, previewProject } = await import("../src/lib/sandbox-proxy");

let fail = 0;
const check = (l: string, ok: boolean, x: unknown = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${l}${!ok && x !== "" ? `  ${JSON.stringify(x)}` : ""}`); };

// A fake Vite: a page, and a WebSocket-style upgrade answer.
const dev = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<h1>app ${req.url}</h1>`); });
dev.on("upgrade", (_req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello-hmr"); });
await new Promise<void>((r) => dev.listen(0, "127.0.0.1", () => r()));
const port = (dev.address() as net.AddressInfo).port;

const pid = "11111111-2222-3333-4444-555555555555";
const g = globalThis as unknown as { __forgeSandboxes?: Map<string, unknown> };
g.__forgeSandboxes ??= new Map();
g.__forgeSandboxes.set(pid, { state: { status: "ready", port, since: Date.now() }, lastSeen: Date.now(), log: [] });

ensurePreviewProxy();
await new Promise((r) => setTimeout(r, 200));
const host = `sbx-${pid}.preview.test`;
const get = (path: string, cookie = "") =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve) => {
    http.get({ host: "127.0.0.1", port: 3911, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: b }));
    });
  });

const url = new URL(previewUrl(pid, port));
check("the preview URL is the project's own https origin with a pass", url.protocol === "https:" && url.host === host && !!url.searchParams.get("__sbx"), url.href);
check("…and stays the same between polls (no iframe reloads)", previewUrl(pid, port) === url.href);
check("the host maps back to the project", previewProject(host) === pid && previewProject("evil.test") === null);
check("without a pass: refused", (await get("/")).status === 403);
const bad = await get("/?__sbx=123.forged");
check("a forged pass: refused", bad.status === 403);
const ok = await get(`/${url.search}`);
const cookie = String(ok.headers["set-cookie"] ?? "").split(";")[0];
check("a good pass sets a cookie and drops it from the address", ok.status === 302 && ok.headers.location === "/" && cookie.startsWith("sbx_pass="), ok.headers);
check("…the cookie is HttpOnly, Secure, SameSite=Lax", /HttpOnly/.test(String(ok.headers["set-cookie"])) && /Secure/.test(String(ok.headers["set-cookie"])) && /SameSite=Lax/.test(String(ok.headers["set-cookie"])));
const page = await get("/dashboard?x=1", cookie);
check("with the cookie, pages come from the project's dev server", page.status === 200 && page.body.includes("app /dashboard?x=1"), page);
const other = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port: 3911, path: "/", headers: { host: "sbx-99999999-2222-3333-4444-555555555555.preview.test", cookie } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }));
check("one project's pass doesn't open another project's preview", other === 503 || other === 403, other);
const ws = await new Promise<string>((resolve) => {
  const s = net.connect(3911, "127.0.0.1", () => s.write(`GET /?token=x HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${cookie}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  let b = "";
  s.on("data", (c) => { b += c; if (b.includes("hello-hmr")) { s.destroy(); resolve(b); } });
  setTimeout(() => { s.destroy(); resolve(b); }, 2000);
});
check("the live-reload WebSocket is passed through", ws.startsWith("HTTP/1.1 101") && ws.includes("hello-hmr"), ws.slice(0, 80));
const wsNo = await new Promise<string>((resolve) => {
  const s = net.connect(3911, "127.0.0.1", () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
  let b = "";
  s.on("data", (c) => (b += c));
  s.on("close", () => resolve(b));
  setTimeout(() => { s.destroy(); resolve(b); }, 1500);
});
check("…but not without the pass", !wsNo.includes("101"));
console.log(`\nPreview proxy: ${fail ? `${fail} FAILED` : "all passed"}`);
process.exit(fail ? 1 : 0);
