/*
 * IOTx Calendar offline copy. Registered by the Calendar page with scope
 * /workspace/calendar, so it controls that page only (Chat, Meet and Tasks are
 * never touched). Everything is network first: online nothing changes; when a
 * request fails it answers from what was saved:
 *   - the Calendar page and its /_next/static files (the app shell),
 *   - the event ranges the page loaded (GET /workspace/api/calendar?from&to),
 *     merged when the exact range wasn't saved, marked "x-cal-saved: 1".
 * Nothing is queued: the page turns editing off while offline.
 */
const SHELL = "iotx-cal-shell-v1";
const DATA = "iotx-cal-data-v1";
const MAX_RANGES = 40;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("iotx-cal-") && k !== SHELL && k !== DATA) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

const PAGE = "/workspace/calendar";
const isStatic = (u) => u.origin === self.location.origin && u.pathname.startsWith("/workspace/_next/static/");
const isRange = (u) => u.origin === self.location.origin && u.pathname === "/workspace/api/calendar";

// The page tells us who is signed in and what it loaded before we were in control.
self.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type !== "shell") return;
  e.waitUntil(
    (async () => {
      const data = await caches.open(DATA);
      // Someone else signed in on this browser: forget the last person's events.
      const who = await data.match("/__iotx_cal_user");
      if (who && (await who.text()) !== String(m.user)) {
        for (const k of await data.keys()) await data.delete(k);
        await (await caches.open(SHELL)).delete(PAGE);
      }
      await data.put("/__iotx_cal_user", new Response(String(m.user)));
      const shell = await caches.open(SHELL);
      const urls = [...new Set((m.urls || []).filter((x) => typeof x === "string"))].slice(0, 300);
      await Promise.all(
        urls.map(async (x) => {
          try {
            if (!isStatic(new URL(x)) || (await shell.match(x))) return;
            const r = await fetch(x);
            if (r.ok) await shell.put(x, r);
          } catch {}
        }),
      );
      try {
        const r = await fetch(PAGE, { credentials: "same-origin" });
        if (r.ok && !r.redirected) await shell.put(PAGE, r);
      } catch {}
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (req.mode === "navigate" && (u.pathname === PAGE || u.pathname === PAGE + "/")) return e.respondWith(page(req));
  if (isStatic(u)) return e.respondWith(staticFile(req));
  if (isRange(u)) return e.respondWith(range(req, u));
});

async function page(req) {
  const shell = await caches.open(SHELL);
  try {
    const r = await fetch(req);
    // Keep the signed-in page (not a bounce to sign-in).
    if (r.ok && !r.redirected && (r.headers.get("content-type") || "").includes("text/html")) await shell.put(PAGE, r.clone());
    return r;
  } catch (err) {
    const hit = await shell.match(PAGE);
    if (hit) return hit;
    throw err;
  }
}

async function staticFile(req) {
  const shell = await caches.open(SHELL);
  try {
    const r = await fetch(req);
    if (r.ok) await shell.put(req.url, r.clone());
    return r;
  } catch (err) {
    const hit = await shell.match(req.url);
    if (hit) return hit;
    throw err;
  }
}

async function range(req, u) {
  const data = await caches.open(DATA);
  try {
    const r = await fetch(req);
    if (r.ok) {
      const copy = new Response(await r.clone().blob(), { headers: { "content-type": "application/json", "x-cal-saved-at": new Date().toISOString() } });
      await data.put(u.pathname + u.search, copy);
      const keys = (await data.keys()).filter((k) => new URL(k.url).pathname === "/workspace/api/calendar");
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RANGES))) await data.delete(k);
    }
    return r;
  } catch (err) {
    const exact = await data.match(u.pathname + u.search);
    if (exact) return mark(await exact.json(), exact.headers.get("x-cal-saved-at"));
    const merged = await merge(data, u);
    if (merged) return merged;
    throw err;
  }
}

function mark(body, at) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-cal-saved": "1", "x-cal-saved-at": at || "" } });
}

/** No exact copy: put together every saved event that falls in the asked range. */
async function merge(data, u) {
  const from = Date.parse(u.searchParams.get("from") || "");
  const to = Date.parse(u.searchParams.get("to") || "");
  if (!from || !to) return null;
  const keys = (await data.keys()).filter((k) => new URL(k.url).pathname === "/workspace/api/calendar");
  if (!keys.length) return null;
  const seen = new Set();
  const events = [], tasks = [];
  let calendars = [], settings = undefined, at = "";
  for (const k of keys) {
    const r = await data.match(k);
    if (!r) continue;
    const d = await r.json().catch(() => null);
    if (!d) continue;
    const when = r.headers.get("x-cal-saved-at") || "";
    if (when >= at) (at = when), (calendars = d.calendars || calendars), (settings = d.settings || settings);
    for (const o of d.events || []) {
      const key = o.id + "|" + (o.occ || o.start);
      if (seen.has(key) || !(Date.parse(o.start) < to && Date.parse(o.end) > from)) continue;
      seen.add(key);
      events.push(o);
    }
    for (const t of d.tasks || []) {
      const day = Date.parse(t.due + "T12:00:00Z");
      if (seen.has("t" + t.id) || !(day >= from - 86400000 && day < to + 86400000)) continue;
      seen.add("t" + t.id);
      tasks.push(t);
    }
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return mark({ calendars, events, tasks, settings }, at);
}
