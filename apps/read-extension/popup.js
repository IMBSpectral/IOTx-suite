// IOTx Read: the toolbar popup. Everything goes through the service worker.
const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const err = (m) => ($("err").textContent = m || "");
const PLATFORM = { meet: "Google Meet", zoom: "Zoom", teams: "Microsoft Teams", other: "this page", iotx: "IOTx Meet" };
const BUILT_IN = ["https://imbspectral.online", "http://localhost:3100", "http://127.0.0.1:3100"];

// ?tab=<id> targets a given tab (used when the popup is opened as a page, e.g. in tests).
const forcedTab = Number(new URLSearchParams(location.search).get("tab")) || null;
let state = null;
let tick = null;

const platformOf = (url) => {
  let h = "";
  try {
    h = new URL(url).hostname;
  } catch {}
  return h === "meet.google.com" ? "meet" : /(^|\.)zoom\.(us|com)$/.test(h) ? "zoom" : /teams\.(microsoft|live)\.com$/.test(h) ? "teams" : "other";
};
const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

async function targetTab() {
  if (forcedTab) return chrome.tabs.get(forcedTab).catch(() => null);
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
}

async function render() {
  state = await send("status");
  $("signin").hidden = state.signedIn;
  $("main").hidden = !state.signedIn;
  $("who").textContent = state.user ? state.user.name || state.user.email : "";
  if (!state.signedIn) {
    $("server").value = state.server;
    return;
  }
  $("openMeet").href = `${state.server}/workspace/meet`;
  $("mic").checked = state.mic;
  const rec = state.rec;
  $("recCard").hidden = !rec;
  $("idleCard").hidden = !!rec;
  clearInterval(tick);
  if (rec) {
    $("recTitle").textContent = `${rec.title} · ${PLATFORM[rec.platform] ?? ""}`;
    $("recInfo").textContent = `${rec.uploaded} chunk(s) sent${rec.failed ? `, ${rec.failed} failed` : ""}${rec.mic ? " · with your mic" : rec.micError ? ` · ${rec.micError}` : " · call audio only"}`;
    const upd = () => ($("timer").textContent = clock(Date.now() - rec.startedAt));
    upd();
    tick = setInterval(upd, 1000);
  } else {
    const tab = await targetTab();
    const p = tab?.url ? platformOf(tab.url) : "other";
    $("tabInfo").textContent = tab?.url && /^https?:/.test(tab.url) ? `Record ${p === "other" ? `"${(tab.title || "this page").slice(0, 60)}"` : `this ${PLATFORM[p]} call`}` : "Open the call's tab, then press Start.";
    $("startBtn").disabled = !state.canRecord || !tab?.url || !/^https?:/.test(tab.url);
    if (!state.canRecord) $("tabInfo").textContent = "Your role can't use AI notes. Ask an admin to turn on Meet AI notes.";
  }
  const last = state.last;
  $("lastCard").hidden = !last || !!rec;
  if (last) {
    const ready = last.notesStatus === "ready" || last.status === "done";
    $("lastText").textContent = last.status === "failed" ? `"${last.title}": ${last.error || "the report couldn't be made."}` : ready ? `"${last.title}": the report is ready.` : `"${last.title}": making the report…`;
    $("lastLink").href = last.reportUrl;
    $("lastLink").hidden = last.status === "failed" && !last.code;
  }
}

async function loadUpcoming() {
  const box = $("upcoming");
  const r = await send("upcoming");
  if (r?.ok === false) {
    box.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = r.error;
    box.append(p);
    return;
  }
  const list = (r?.meetings ?? []).filter((m) => new Date(m.end) > new Date());
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<p class="muted small">No meetings with a call link in the next 24 hours.</p>';
    $("nextBtn").hidden = true;
    return;
  }
  const next = list.find((m) => m.platform !== "iotx") ?? null;
  $("nextBtn").hidden = !next;
  $("nextBtn").onclick = () => openMeeting(next);
  for (const m of list) {
    const row = document.createElement("div");
    row.className = "item";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = time(m.start);
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = m.title;
    t.title = `${m.title} · ${PLATFORM[m.platform] ?? m.platform}`;
    const b = document.createElement("button");
    b.textContent = m.platform === "iotx" ? "Join" : "Join + notes";
    b.title = m.platform === "iotx" ? "IOTx Meet makes its own notes" : "Opens the call; press Start there";
    b.onclick = () => openMeeting(m);
    row.append(when, t, b);
    box.append(row);
  }
}

async function openMeeting(m) {
  err("");
  const r = await send("open", { url: m.url, eventId: m.platform === "iotx" ? undefined : m.id });
  if (r?.ok === false) err(r.error);
  else if (!forcedTab) window.close();
}

$("signinBtn").onclick = async () => {
  err("");
  const server = ($("server").value.trim() || "https://imbspectral.online").replace(/\/+$/, "").replace(/\/workspace$/, "");
  // A server we don't know yet needs the person's OK (asked during this click).
  if (!BUILT_IN.includes(server)) {
    const ok = await chrome.permissions.request({ origins: [`${server}/*`] }).catch(() => false);
    if (!ok) return err("The extension needs permission to reach that server.");
  }
  $("signinBtn").disabled = true;
  const r = await send("signIn", { server, code: $("code").value, token: $("token").value });
  $("signinBtn").disabled = false;
  if (r?.ok === false) return err(r.error);
  await render();
  loadUpcoming();
};

$("startBtn").onclick = async () => {
  err("");
  $("startBtn").disabled = true;
  const tab = await targetTab();
  const r = await send("start", { tabId: tab?.id, mic: $("mic").checked });
  $("startBtn").disabled = false;
  if (r?.ok === false) err(r.error);
  await render();
};
$("stopBtn").onclick = async () => {
  err("");
  $("stopBtn").disabled = true;
  const r = await send("stop");
  $("stopBtn").disabled = false;
  if (r?.ok === false) err(r.error);
  await render();
};
$("discardBtn").onclick = async () => {
  await send("discard");
  await render();
};
$("mic").onchange = () => send("setMic", { on: $("mic").checked });
$("micAllow").onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
};
$("signoutBtn").onclick = async () => {
  await send("signOut");
  await render();
};

render().then(() => state?.signedIn && loadUpcoming());
// While the popup is open, keep the status fresh (chunks sent, report ready).
setInterval(() => render().catch(() => {}), 3000);
