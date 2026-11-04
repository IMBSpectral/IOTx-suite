// IOTx Read: the service worker. It talks to IOTx Workspace (the token lives
// here, in chrome.storage.local), starts and stops tab capture, and owns the
// offscreen document that records (tab audio + the mic) and uploads chunks.
// Nothing is ever recorded without the person pressing Start, and while a
// recording runs the page shows a "Recording for notes" badge and the
// toolbar icon shows REC.

const OFFSCREEN = "offscreen.html";
const DEFAULT_SERVER = "https://imbspectral.online";

const local = {
  get: (k) => chrome.storage.local.get(k),
  set: (o) => chrome.storage.local.set(o),
  remove: (k) => chrome.storage.local.remove(k),
};
// The current recording survives the service worker going to sleep.
const session = {
  get: async () => (await chrome.storage.session.get("rec")).rec ?? null,
  set: (rec) => chrome.storage.session.set({ rec }),
  clear: () => chrome.storage.session.remove("rec"),
};

const cleanServer = (s) => String(s || DEFAULT_SERVER).trim().replace(/\/+$/, "").replace(/\/workspace$/, "");

async function api(path, init = {}) {
  const { server, token } = await local.get(["server", "token"]);
  if (!token) throw Object.assign(new Error("Sign in first."), { status: 401 });
  const headers = { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) };
  const r = await fetch(`${cleanServer(server)}/workspace/api${path}`, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) await local.remove(["token", "user"]); // revoked: sign out here too
    throw Object.assign(new Error(d.error || `The server answered ${r.status}.`), { status: r.status });
  }
  return d;
}

export function platformOf(url) {
  let h = "";
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {}
  if (h === "meet.google.com") return "meet";
  if (h === "zoom.us" || h.endsWith(".zoom.us") || h.endsWith(".zoom.com")) return "zoom";
  if (h === "teams.microsoft.com" || h === "teams.live.com" || h.endsWith(".teams.microsoft.com")) return "teams";
  return "other";
}

// ── Signing in ──────────────────────────────────────────────────────────────

async function signIn({ server, code, token }) {
  const base = cleanServer(server);
  let tok = String(token || "").trim();
  if (!tok) {
    const r = await fetch(`${base}/workspace/api/meet/ext/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: `Browser extension (${navigator.userAgentData?.platform || "Chrome"})` }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `The server answered ${r.status}.`);
    tok = d.token;
  }
  await local.set({ server: base, token: tok });
  try {
    const me = await api("/meet/ext/me");
    await local.set({ user: me.user, canRecord: me.canRecord });
    return { ok: true, user: me.user };
  } catch (e) {
    await local.remove(["token", "user"]);
    throw e;
  }
}

// ── The page (content script) ───────────────────────────────────────────────

async function ensureContent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (pong?.ok) return true;
  } catch {}
  try {
    // Pages that aren't Meet, Zoom or Teams: the popup click (activeTab) lets us add it now.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}

async function scrape(tabId) {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: "scrape" })) ?? {};
  } catch {
    return {};
  }
}

const tellPage = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => {});

// ── Offscreen recorder ──────────────────────────────────────────────────────

async function ensureOffscreen() {
  const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  if (have.length) return;
  await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ["USER_MEDIA"], justification: "Record the call's audio (tab and microphone) for meeting notes." });
}
async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {}
}
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(msg)), ms))]);
const toOffscreen = (msg) => chrome.runtime.sendMessage({ ...msg, target: "offscreen" });

async function setIcon(on) {
  await chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
  await chrome.action.setTitle({ title: on ? "IOTx Read: recording for notes" : "IOTx Read" });
}

// ── Start / stop ────────────────────────────────────────────────────────────

async function start({ tabId, mic, eventId }) {
  if (await session.get()) throw new Error("A recording is already running. Stop it first.");
  const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id) throw new Error("Open the call's tab first.");
  if (!/^https?:/.test(tab.url || "https:")) throw new Error("This page can't be recorded. Open the call's tab.");
  const shown = await ensureContent(tab.id);
  const info = await scrape(tab.id);
  const url = tab.url || info.url || "";
  const { pending = {} } = await chrome.storage.session.get("pending");
  const ev = eventId || pending[tab.id] || undefined;
  const cap = await api("/meet/ext/capture", { body: { title: info.title || "", platform: platformOf(url), url, participants: info.participants || [], eventId: ev, mime: "audio/webm" } });
  const { server, token } = await local.get(["server", "token"]);
  let r;
  try {
    await ensureOffscreen();
    // A stream id is only good for a few seconds: ask for it right before the recorder uses it.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    r = await withTimeout(toOffscreen({ type: "start", streamId, mic: !!mic, server: cleanServer(server), token, captureId: cap.captureId }), 15000, "The recorder didn't start in time. Try again.");
  } catch (e) {
    r = { ok: false, error: e?.message || String(e) };
  }
  if (!r?.ok) {
    await api(`/meet/ext/capture/${cap.captureId}`, { method: "DELETE" }).catch(() => {});
    await closeOffscreen();
    throw new Error(r?.error || "The recorder couldn't start.");
  }
  const rec = { captureId: cap.captureId, code: cap.code, reportUrl: cap.reportUrl, title: cap.title, platform: cap.platform, tabId: tab.id, startedAt: Date.now(), mic: !!r.mic, micError: r.micError || "", badge: shown, uploaded: 0, failed: 0 };
  await session.set(rec);
  await setIcon(true);
  await tellPage(tab.id, { type: "badge", on: true });
  return { ok: true, rec };
}

let stopping = null;
async function stop(reason = "stopped") {
  if (stopping) return stopping;
  stopping = (async () => {
    const rec = await session.get();
    if (!rec) return { ok: false, error: "Nothing is being recorded." };
    const r = await toOffscreen({ type: "stop" }).catch(() => null);
    await closeOffscreen();
    const info = await scrape(rec.tabId);
    await tellPage(rec.tabId, { type: "badge", on: false });
    await setIcon(false);
    await session.clear();
    let status;
    try {
      status = await api(`/meet/ext/capture/${rec.captureId}/finish`, { body: { title: info.title || undefined, participants: info.participants || [] } });
    } catch (e) {
      status = { status: "failed", error: e.message };
    }
    const last = { captureId: rec.captureId, code: rec.code, title: status.title || rec.title, reportUrl: rec.reportUrl, status: status.status, notesStatus: status.notesStatus, error: status.error || "", failedChunks: r?.failed ?? 0, reason, at: Date.now() };
    await local.set({ last });
    return { ok: true, last };
  })();
  try {
    return await stopping;
  } finally {
    stopping = null;
  }
}

async function discard() {
  const rec = await session.get();
  if (!rec) return { ok: false };
  await toOffscreen({ type: "stop", discard: true }).catch(() => null);
  await closeOffscreen();
  await tellPage(rec.tabId, { type: "badge", on: false });
  await setIcon(false);
  await session.clear();
  await api(`/meet/ext/capture/${rec.captureId}`, { method: "DELETE" }).catch(() => {});
  return { ok: true };
}

/** The popup's "Add notes to my next meeting": open the call and remember which calendar event it is. */
async function openMeeting({ url, eventId }) {
  const tab = await chrome.tabs.create({ url });
  if (eventId) {
    const { pending = {} } = await chrome.storage.session.get("pending");
    pending[tab.id] = eventId;
    await chrome.storage.session.set({ pending });
  }
  return { ok: true, tabId: tab.id };
}

async function status() {
  const { server, token, user, last, canRecord, mic } = await local.get(["server", "token", "user", "last", "canRecord", "mic"]);
  const rec = await session.get();
  let lastNow = last ?? null;
  if (token && last && last.status !== "done" && last.status !== "failed" && Date.now() - last.at < 2 * 3_600_000) {
    try {
      const s = await api(`/meet/ext/capture/${last.captureId}`);
      lastNow = { ...last, status: s.status, notesStatus: s.notesStatus, error: s.error || s.notesError || "", title: s.title };
      await local.set({ last: lastNow });
    } catch {}
  }
  return { signedIn: !!token, server: server || DEFAULT_SERVER, user: user ?? null, canRecord: canRecord !== false, mic: mic !== false, rec, last: lastNow };
}

// ── Messages ────────────────────────────────────────────────────────────────

const handlers = {
  status: () => status(),
  signIn: (m) => signIn(m),
  signOut: async () => (await local.remove(["token", "user", "last"]), { ok: true }),
  setMic: async (m) => (await local.set({ mic: !!m.on }), { ok: true }),
  start: (m) => start(m),
  stop: () => stop("stopped"),
  discard: () => discard(),
  upcoming: async () => api("/meet/ext/upcoming"),
  open: (m) => openMeeting(m),
  // From the page: the badge's Stop button, names seen during the call, a reload.
  "page-stop": () => stop("stopped from the page"),
  hello: async (_m, sender) => {
    const rec = await session.get();
    return { recording: !!rec && rec.tabId === sender.tab?.id };
  },
  "page-info": async (m, sender) => {
    const rec = await session.get();
    if (!rec || rec.tabId !== sender.tab?.id) return { ok: false };
    await api(`/meet/ext/capture/${rec.captureId}`, { method: "PATCH", body: { title: m.title || undefined, participants: m.participants || [] } }).catch(() => {});
    return { ok: true };
  },
  // From the recorder.
  progress: async (m) => {
    const rec = await session.get();
    if (rec) await session.set({ ...rec, uploaded: m.uploaded, failed: m.failed });
    return { ok: true };
  },
  "tab-ended": () => stop("the tab was closed"),
};

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || m.target === "offscreen") return false;
  const h = handlers[m.type];
  if (!h) return false;
  Promise.resolve(h(m, sender)).then(reply, (e) => reply({ ok: false, error: e?.message || String(e) }));
  return true;
});

// Closing the call's tab finishes the recording (the report is still made).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await session.get();
  if (rec?.tabId === tabId) await stop("the tab was closed");
  const { pending = {} } = await chrome.storage.session.get("pending");
  if (pending[tabId]) {
    delete pending[tabId];
    await chrome.storage.session.set({ pending });
  }
});

chrome.runtime.onStartup.addListener(() => setIcon(false));
