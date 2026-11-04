/**
 * IOTx Read browser extension, end to end in a real Chromium: the unpacked
 * extension (apps/read-extension) is loaded into a Playwright-launched
 * Chromium (Playwright's Chromium build, its own browser profile, not the
 * shared one), signs in with a pairing code through its popup,
 * records a local test page on 127.0.0.1:4797 that plays synthesized speech
 * (tab capture in the offscreen document + Chromium's fake microphone),
 * shows the "Recording for notes" badge, uploads 10-second chunks, stops, and
 * the report is made from what it heard.
 *   npx tsx scripts/test-meet-extension.mts <devToken> <test-users.json>
 * Chromium is driven over plain CDP (not Playwright, whose auto-attach paused
 * the extension's service worker and offscreen document). The flag
 * --allowlisted-extension-id lets the test start tab capture without a
 * toolbar click; a person always clicks Start in the popup.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import pg from "pg";
const getJson = async (url: string, token: string) => {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { httpStatus: r.status, body: t.slice(0, 200) };
  }
};
import { check, envOf, OWNER, setup, signIn, sleep, summary, ws, WS, WS_ORIGIN } from "./lib.mts";

const env = envOf(path.join(import.meta.dirname, "..", ".env"));
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const EXT_SRC = path.resolve(import.meta.dirname, "..", "..", "read-extension");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c-ext-browser-"));
const PAGE_PORT = 4797;
const PAGE = `http://127.0.0.1:${PAGE_PORT}`;

// ── A test copy of the extension: fixed id (manifest key) and the local test page allowed ──
const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const extId = [...crypto.createHash("sha256").update(der).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const extDir = path.join(tmp, "ext");
fs.cpSync(EXT_SRC, extDir, { recursive: true, filter: (s) => !/[\\/](dist|scripts|node_modules)([\\/]|$)/.test(s) });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
manifest.key = der.toString("base64");
manifest.host_permissions.push(`${PAGE}/*`);
manifest.content_scripts[0].matches.push(`${PAGE}/*`);
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));
if (process.env.EARLY_ID) {
  const bgFile = path.join(extDir, "background.js");
  let bg = fs.readFileSync(bgFile, "utf8");
  bg = bg.replace('  const cap = await api("/meet/ext/capture"', '  const earlyId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });\n  const cap = await api("/meet/ext/capture"');
  bg = bg.replace("const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });", "const streamId = earlyId;");
  fs.writeFileSync(bgFile, bg);
}

// ── The test "call": a page that plays synthesized speech and lists two people ──
const wav = path.join(tmp, "speech.wav");
const SPEECH = "Welcome to the customer onboarding call. We agreed that the onboarding checklist goes live on Monday. Priya will email the welcome pack to the customer tomorrow. Thanks everyone.";
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${SPEECH}'); $s.Dispose()`]);
const speech = fs.readFileSync(wav);
const html = `<!doctype html><title>Customer onboarding call</title>
<h1>Customer onboarding call</h1>
<ul><li data-participant-name="Priya Shah">Priya Shah</li><li data-participant-name="Tom Becker">Tom Becker</li></ul>
<audio id="a" src="/speech.wav" autoplay loop></audio>
<script>document.getElementById("a").play().catch(() => {});</script>`;
const pageServer = http.createServer((req, res) => {
  if (req.url === "/speech.wav") return res.writeHead(200, { "content-type": "audio/wav", "content-length": speech.length }).end(speech);
  res.writeHead(200, { "content-type": "text/html" }).end(html);
});
await new Promise<void>((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", () => r()));

await setup();
const O = await signIn(OWNER, "meetings");
const made = await ws("/meet/tokens", { kind: "extension", name: "Browser test" }, O);
check("a pairing code from Meet → Integrations", made.status === 201 && !!made.json.pairCode, made.json);

// Chromium (Playwright's build) driven over plain CDP: only the popup and the call's page are
// attached, so the extension's service worker and offscreen document run untouched.
const CHROME = path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1148", "chrome-win", "chrome.exe");
let PORT = 0;
const proc = spawn(CHROME, [
  `--user-data-dir=${path.join(tmp, "profile")}`,
  "--remote-debugging-port=0",
  `--disable-extensions-except=${extDir}`,
  `--load-extension=${extDir}`,
  `--allowlisted-extension-id=${extId}`,
  "--auto-accept-this-tab-capture",
  "--use-fake-ui-for-media-stream",
  ...(process.env.FAKE_DEVICE === "0" ? [] : ["--use-fake-device-for-media-stream"]),
  "--autoplay-policy=no-user-gesture-required",
  "--no-first-run",
  // Never audible: Chromium still hands the muted tab's sound to tab capture.
  "--mute-audio",
  "--no-sandbox",
  // Playwright's usual switches: the window is off screen, so keep it from being treated as hidden.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-features=GlobalMediaControls,MediaRouter,DialMediaRouteProvider",
  "--no-default-browser-check",
  "--window-position=-2400,0",
  "--window-size=1000,700",
  "about:blank",
], { stdio: "ignore" });
// Our own browser's DevTools port (never a fixed port: another browser may already be on it).
for (let i = 0; i < 100 && !PORT; i++) {
  const f = path.join(tmp, "profile", "DevToolsActivePort");
  if (fs.existsSync(f)) PORT = Number(fs.readFileSync(f, "utf8").split("\n")[0].trim()) || 0;
  if (!PORT) await sleep(200);
}
if (!PORT) throw new Error("Chromium didn't start");
const devtools = async (p: string, method = "GET") => {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method });
      const t = await r.text();
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chromium's DevTools port didn't open");
};
type Page = { id: string; eval: (expr: string) => Promise<any>; click: (selector: string) => Promise<void>; close: () => void };
async function attach(target: { id: string; webSocketDebuggerUrl: string }): Promise<Page> {
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, no) => ((sock.onopen = r), (sock.onerror = no)));
  let n = 0;
  const waiting = new Map<number, (v: any) => void>();
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) waiting.get(m.id)!(m);
  };
  const send = (method: string, params: unknown) =>
    new Promise<any>((r) => {
      const id = ++n;
      waiting.set(id, r);
      sock.send(JSON.stringify({ id, method, params }));
    });
  return {
    id: target.id,
    async eval(expr: string) {
      const m = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text);
      return m.result?.result?.value;
    },
    /** A real mouse click (a trusted user gesture, like a person's). */
    async click(selector: string) {
      const m = await send("Runtime.evaluate", { expression: `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`, returnByValue: true });
      const r = m.result.result.value as { x: number; y: number };
      await send("Page.bringToFront", {});
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
    },
    close: () => sock.close(),
  };
}
async function open(url: string) {
  const t = await devtools(`/json/new?${encodeURIComponent(url)}`, "PUT");
  await sleep(1500);
  return attach(t);
}
const until = async (page: Page, expr: string, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await page.eval(expr).catch(() => false)) return true;
    await sleep(300);
  }
  return false;
};
const status = (popup: Page) => popup.eval(`return await chrome.runtime.sendMessage({ type: "status" });`);

let captureId = "";
try {
  await devtools("/json/version");
  let sw: any = null;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = ((await devtools("/json/list")) as any[]).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!sw) await sleep(500);
  }
  check("the extension loads (MV3 service worker running)", !!sw, sw ?? (await devtools("/json/list")).map((t: any) => `${t.type} ${t.url}`));

  // Popup (opened as a page): sign in with the pairing code.
  const popup = await open(`chrome-extension://${extId}/popup.html`);
  await until(popup, `return !!document.getElementById("signinBtn") && !document.getElementById("signin").hidden;`);
  await popup.eval(`document.getElementById("server").value = ${JSON.stringify(WS_ORIGIN)}; document.getElementById("code").value = ${JSON.stringify(made.json.pairCode)}; document.getElementById("signinBtn").click(); return true;`);
  check("popup: signed in with the code", await until(popup, `return !document.getElementById("main").hidden && document.getElementById("who").textContent.length > 0;`));
  check("popup: lists the next meetings from Calendar (or says there are none)", await until(popup, `return !/Loading/.test(document.getElementById("upcoming").textContent) && document.getElementById("upcoming").textContent.length > 0;`));

  // The call's tab.
  const call = await open(PAGE);
  check("the test call plays speech", await until(call, `const a = document.getElementById("a"); return a && !a.paused && a.currentTime > 0.3;`));
  const tabId = await popup.eval(`return (await chrome.tabs.query({ url: ${JSON.stringify(`${PAGE}/*`)} }))[0]?.id ?? null;`);
  check("found the call's tab", typeof tabId === "number", tabId);
  await popup.eval(`location.href = "popup.html?tab=${tabId}"; return true;`);
  await sleep(1500);
  await until(popup, `return !document.getElementById("main").hidden && !document.getElementById("startBtn").disabled;`);
  const info = await popup.eval(`return document.getElementById("tabInfo").textContent;`);
  check("popup: offers to record this page", /Customer onboarding call/.test(info ?? ""), info);
  // A person presses Start from the toolbar while on the call's tab.
  if (process.env.ACTIVATE) await devtools(`/json/activate/${call.id}`);
  await popup.click("#startBtn");
  await until(popup, `return !document.getElementById("recCard").hidden || !!document.getElementById("err").textContent;`, 30000);
  const err = await popup.eval(`return document.getElementById("err").textContent;`);
  const st0 = await status(popup);
  captureId = st0.rec?.captureId ?? "";
  if (!captureId && process.env.PROBE) {
    const probe = await popup.eval(`
      const out = [];
      for (const v of ["plain", "consumer"]) {
        try {
          const id = await chrome.tabCapture.getMediaStreamId(v === "plain" ? { targetTabId: ${tabId} } : { targetTabId: ${tabId}, consumerTabId: (await chrome.tabs.getCurrent()).id });
          const s = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } }, video: false });
          out.push(v + ": ok " + s.getAudioTracks().length);
          s.getTracks().forEach((t) => t.stop());
        } catch (e) { out.push(v + ": " + e.name + " " + e.message); }
      }
      return out.join(" | ");`).catch((e: Error) => e.message);
    console.log("PROBE", probe);
  }
  check("Start: recording (tab capture in the offscreen document)", !!captureId, { err, st0 });
  check("…the mic is mixed in (Chromium's fake microphone)", st0.rec?.mic === true, st0.rec);
  check("the page shows the 'Recording for notes' badge", await until(call, `return !!document.querySelector("iotx-read-badge");`, 5000));
  const badge = await popup.eval(`return await chrome.action.getBadgeText({});`);
  check("the toolbar icon shows REC", badge === "REC", badge);

  // Let it record ~25 s (two full 10-second chunks plus a partial one at stop).
  await sleep(25000);
  const tok = (await popup.eval(`return await chrome.storage.local.get("token");`)).token as string;
  const s1 = await getJson(`${WS}/api/meet/ext/capture/${captureId}`, tok);
  check("chunks arrive while recording (every 10 s)", s1.chunks >= 2 && s1.bytes > 10_000, s1);
  check("the page's title and names were sent", s1.title === "Customer onboarding call" && s1.participants?.includes("Priya Shah") && s1.participants?.includes("Tom Becker"), s1);
  const shown = await popup.eval(`return document.getElementById("recInfo").textContent;`);
  check("popup: shows chunks sent and the mic", /chunk\(s\) sent/.test(shown) && /with your mic/.test(shown), shown);

  await popup.click("#stopBtn");
  check("Stop: the popup is back to idle", await until(popup, `return !document.getElementById("idleCard").hidden;`, 30000));
  check("…the badge goes away", await until(call, `return !document.querySelector("iotx-read-badge");`, 5000));
  check("…REC goes off the icon", (await popup.eval(`return await chrome.action.getBadgeText({});`)) === "");
  let st: any = {};
  for (let i = 0; i < 100; i++) {
    st = await getJson(`${WS}/api/meet/ext/capture/${captureId}`, tok);
    if (["done", "failed"].includes(st.status)) break;
    await sleep(3000);
  }
  check("the report is made from what the extension recorded", st.status === "done" && st.notesStatus === "ready", st);
  const text = (await db.query(`select string_agg(text, ' ' order by seq) t from meet_segments where "meetingId" = $1`, [st.meetingId])).rows[0]?.t ?? "";
  check("…the transcript has the call's words (tab audio)", /onboarding/i.test(text) && /(welcome pack|monday)/i.test(text), text.slice(0, 300));
  const last = await status(popup);
  check("popup: links to the report", String(last.last?.reportUrl ?? "").endsWith(`/workspace/meet/${st.code}/notes`), last.last);
  await popup.eval(`document.getElementById("signoutBtn").click(); return true;`);
  check("sign out", await until(popup, `return !document.getElementById("signin").hidden;`, 5000));
  popup.close();
  call.close();
} finally {
  proc.kill();
  pageServer.close();
  await ws(`/meet/tokens/${made.json.item?.id}`, undefined, O, "DELETE").catch(() => {});
  await db.end();
  await sleep(1000);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(summary("test-meet-extension") ? 1 : 0);
