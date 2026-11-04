import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PROJECTS_ROOT } from "./paths";
import { assertPublicUrl } from "./net";
import { mayRun } from "./tool-permissions";

/**
 * The cloud browser: a real browser the agent uses for a project (look
 * something up, fill a form, check a site), shown live in the Browser tab.
 * The person can take over at any time (the agent pauses) and hand back.
 *
 * It can only reach public addresses (every request is checked), only sites
 * the workspace allows (or approved on a card), closes after sitting idle,
 * keeps a history of what was done for audit, and admins can switch it off.
 */

export class BrowserError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export type BrowserSettings = { enabled: boolean; anySite: boolean; allowed: string[]; idleMinutes: number };
const DEFAULTS: BrowserSettings = { enabled: true, anySite: false, allowed: [], idleMinutes: 10 };

type Session = { context: BrowserContext; page: Page; workspaceId: string; lastAgentAt: number; lastUsed: number; controlledBy: "agent" | "user"; controller: string | null };

const g = globalThis as unknown as { __forgeCloudBrowser?: Promise<Browser>; __forgeBrowserSessions?: Map<string, Session>; __forgeBrowserReaper?: ReturnType<typeof setInterval> };
const sessions = (g.__forgeBrowserSessions ??= new Map());

function browser() {
  g.__forgeCloudBrowser ??= chromium.launch({ headless: true }).catch((e) => {
    g.__forgeCloudBrowser = undefined;
    throw e;
  });
  return g.__forgeCloudBrowser;
}

const settingsFile = (ws: string) => path.join(PROJECTS_ROOT, "_forge", "browser", `${ws.replace(/[^\w-]/g, "")}.json`);
const historyFile = (projectId: string) => path.join(PROJECTS_ROOT, "_forge", "browser-history", `${projectId.replace(/[^\w-]/g, "")}.jsonl`);

export async function browserSettings(ws: string): Promise<BrowserSettings> {
  const raw = await fs.readFile(settingsFile(ws), "utf8").catch(() => null);
  return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<BrowserSettings>) : {}) };
}

export async function saveBrowserSettings(ws: string, patch: Partial<BrowserSettings>) {
  const s = await browserSettings(ws);
  if (typeof patch.enabled === "boolean") s.enabled = patch.enabled;
  if (typeof patch.anySite === "boolean") s.anySite = patch.anySite;
  if (Array.isArray(patch.allowed)) {
    s.allowed = [...new Set(patch.allowed.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 100);
  }
  if (typeof patch.idleMinutes === "number" && patch.idleMinutes >= 1 && patch.idleMinutes <= 120) s.idleMinutes = Math.round(patch.idleMinutes);
  await fs.mkdir(path.dirname(settingsFile(ws)), { recursive: true });
  await fs.writeFile(settingsFile(ws), JSON.stringify(s, null, 2));
  if (!s.enabled) for (const [pid, sess] of sessions) if (sess.workspaceId === ws) await closeBrowser(pid, "admin");
  return s;
}

async function log(projectId: string, actor: string, action: string, detail: string) {
  await fs.mkdir(path.dirname(historyFile(projectId)), { recursive: true });
  await fs.appendFile(historyFile(projectId), JSON.stringify({ at: new Date().toISOString(), actor, action, detail: detail.slice(0, 300) }) + "\n");
}

export async function browserHistory(projectId: string) {
  const raw = await fs.readFile(historyFile(projectId), "utf8").catch(() => "");
  return raw.trim().split("\n").filter(Boolean).slice(-200).reverse().map((l) => JSON.parse(l) as { at: string; actor: string; action: string; detail: string });
}

/** Whether a site may be opened: the workspace's list, any site, or a card approval. */
async function siteAllowed(ws: string, host: string) {
  const s = await browserSettings(ws);
  if (s.anySite) return true;
  if (s.allowed.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  return mayRun(ws, `connector:browser:${host}`, "ask");
}

async function session(projectId: string, workspaceId: string) {
  const s = await browserSettings(workspaceId);
  if (!s.enabled) throw new BrowserError("The cloud browser is switched off for this workspace.", 403);
  let sess = sessions.get(projectId);
  if (!sess) {
    const context = await (await browser()).newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false });
    // Every request, not just navigations, must go to a public address.
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") return route.continue();
      try {
        await assertPublicUrl(url);
        return route.continue();
      } catch {
        return route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    sess = { context, page, workspaceId, lastAgentAt: 0, lastUsed: Date.now(), controlledBy: "agent", controller: null };
    sessions.set(projectId, sess);
    ensureReaper();
  }
  sess.lastUsed = Date.now();
  return sess;
}

function agentSession(sess: Session) {
  if (sess.controlledBy === "user") throw new BrowserError("The person has taken over the browser, so you're paused. Wait until they hand it back.", 409);
  sess.lastAgentAt = Date.now();
}

/** "live" while the agent is acting, "online" while open, "not in use" when closed. */
export function browserState(projectId: string) {
  const s = sessions.get(projectId);
  if (!s) return { state: "not in use" as const, url: null, controlledBy: null };
  return { state: Date.now() - s.lastAgentAt < 15_000 && s.controlledBy === "agent" ? ("live" as const) : ("online" as const), url: s.page.url(), controlledBy: s.controlledBy };
}

export async function openUrl(projectId: string, workspaceId: string, raw: string, actor: string, asAgent = true) {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BrowserError("That isn't a web address.");
  }
  await assertPublicUrl(u).catch(() => {
    throw new BrowserError("The cloud browser only opens public websites.", 403);
  });
  if (asAgent && !(await siteAllowed(workspaceId, u.hostname))) {
    throw new BrowserError(`NOT_ALLOWED:${u.hostname}`, 403);
  }
  const sess = await session(projectId, workspaceId);
  if (asAgent) agentSession(sess);
  await sess.page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e: Error) => {
    throw new BrowserError(`Couldn't open ${u.hostname}: ${e.message.split("\n")[0]}`);
  });
  await sess.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await log(projectId, actor, "open", u.toString());
  return { url: sess.page.url(), title: await sess.page.title() };
}

type Act = { kind: "click"; selector?: string; text?: string; x?: number; y?: number } | { kind: "type"; selector?: string; text: string } | { kind: "press"; key: string } | { kind: "scroll"; dy: number };

export async function act(projectId: string, workspaceId: string, a: Act, actor: string, asAgent = true) {
  const sess = sessions.get(projectId);
  if (!sess) throw new BrowserError("The browser isn't open. Open a page first.", 409);
  if (asAgent) agentSession(sess);
  else if (sess.controlledBy !== "user") throw new BrowserError("Take over the browser first.", 409);
  sess.lastUsed = Date.now();
  const p = sess.page;
  if (a.kind === "click") {
    if (typeof a.x === "number" && typeof a.y === "number") await p.mouse.click(a.x, a.y);
    else if (a.selector) await p.click(a.selector, { timeout: 8000 });
    else if (a.text) await p.getByText(a.text, { exact: false }).first().click({ timeout: 8000 });
    else throw new BrowserError("Say what to click.");
  } else if (a.kind === "type") {
    if (a.selector) await p.fill(a.selector, a.text, { timeout: 8000 });
    else await p.keyboard.type(a.text);
  } else if (a.kind === "press") {
    if (!/^[A-Za-z0-9+]{1,30}$/.test(a.key)) throw new BrowserError("Unknown key.");
    await p.keyboard.press(a.key);
  } else if (a.kind === "scroll") {
    await p.mouse.wheel(0, Math.max(-5000, Math.min(5000, a.dy)));
  }
  await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
  // Passwords typed by the person never land in the history.
  const detail = a.kind === "type" ? `${a.selector ?? "(focused field)"}: ${actor === "agent" ? a.text.slice(0, 80) : "[typed text]"}` : JSON.stringify({ ...a, kind: undefined });
  await log(projectId, actor, a.kind, detail);
  return { url: p.url(), title: await p.title() };
}

export async function screenshot(projectId: string) {
  const sess = sessions.get(projectId);
  if (!sess) throw new BrowserError("The browser isn't open.", 404);
  return sess.page.screenshot({ type: "jpeg", quality: 70 });
}

/** The page's readable text (for the agent), trimmed. */
export async function readPage(projectId: string) {
  const sess = sessions.get(projectId);
  if (!sess) throw new BrowserError("The browser isn't open. Open a page first.", 409);
  agentSession(sess);
  const text = await sess.page.evaluate(() => document.body?.innerText ?? "");
  return { url: sess.page.url(), title: await sess.page.title(), text: text.replace(/\n{3,}/g, "\n\n").slice(0, 12_000) };
}

/** Fill a login form with a saved login; the values never pass through the agent. */
export async function fillLogin(projectId: string, workspaceId: string, username: string, password: string) {
  const sess = sessions.get(projectId);
  if (!sess) throw new BrowserError("Open the site's login page first.", 409);
  agentSession(sess);
  const p = sess.page;
  const user = p.locator('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[type="text"]').first();
  const pass = p.locator('input[type="password"]').first();
  if (!(await pass.count())) throw new BrowserError("There's no password field on this page.");
  if (await user.count()) await user.fill(username, { timeout: 5000 });
  await pass.fill(password, { timeout: 5000 });
  await pass.press("Enter");
  await p.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
  await log(projectId, "agent", "login", `Signed in to ${new URL(p.url()).hostname} with a saved login`);
  return { url: p.url(), title: await p.title() };
}

export async function takeOver(projectId: string, who: string) {
  const sess = sessions.get(projectId);
  if (!sess) throw new BrowserError("The browser isn't open.", 404);
  sess.controlledBy = "user";
  sess.controller = who;
  await log(projectId, who, "take over", "The agent is paused");
}

export async function handBack(projectId: string, who: string) {
  const sess = sessions.get(projectId);
  if (!sess) throw new BrowserError("The browser isn't open.", 404);
  sess.controlledBy = "agent";
  sess.controller = null;
  await log(projectId, who, "hand back", "The agent can continue");
}

export async function closeBrowser(projectId: string, who: string) {
  const sess = sessions.get(projectId);
  if (!sess) return;
  sessions.delete(projectId);
  await sess.context.close().catch(() => undefined);
  await log(projectId, who, "close", who === "idle" ? "Closed after sitting idle" : "Closed");
}

function ensureReaper() {
  if (g.__forgeBrowserReaper) return;
  g.__forgeBrowserReaper = setInterval(async () => {
    for (const [pid, s] of sessions) {
      const limit = (await browserSettings(s.workspaceId)).idleMinutes * 60_000;
      if (Date.now() - s.lastUsed > limit) await closeBrowser(pid, "idle");
    }
  }, 30_000);
}
