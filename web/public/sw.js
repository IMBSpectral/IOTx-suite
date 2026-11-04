// Forge's service worker: makes Forge installable and shows a friendly page
// when you're offline. Everything else goes straight to the network.
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge · Offline</title><body style="margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui;background:#0f0f12;color:#ececf1">
<div style="text-align:center"><h1 style="font-size:20px">You're offline</h1><p style="color:#9a9aa5">Forge will be back when your connection is.</p>
<button onclick="location.reload()" style="padding:8px 14px;border-radius:8px;border:0;background:#6d4aff;color:#fff">Try again</button></div>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  // Top-level pages only: a suite tab's page (an iframe) goes straight to the network, so the
  // server still sees Sec-Fetch-Dest: iframe and leaves out the suite's frame.
  if (e.request.mode !== "navigate" || e.request.destination !== "document") return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } })));
});
