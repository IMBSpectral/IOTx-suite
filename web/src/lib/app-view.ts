import { chromium, type Browser } from "playwright-core";
import { ensureSandbox } from "./sandbox";

/**
 * Lets the agent look at the app it built: a screenshot of the running
 * preview at a given width, plus what went wrong on the page (console errors,
 * failed requests) and whether anything spills sideways. One headless
 * browser is shared and started on first use.
 */

const g = globalThis as unknown as { __forgeBrowser?: Promise<Browser> };

function browser() {
  g.__forgeBrowser ??= chromium.launch({ headless: true }).catch((e) => {
    g.__forgeBrowser = undefined;
    throw e;
  });
  return g.__forgeBrowser;
}

export type AppView = { image: string; title: string; errors: string[]; overflowsX: boolean; scrollWidth: number };

export class AppViewError extends Error {}

export async function viewApp(
  projectId: string,
  opts: { path?: string; width?: number; session?: { token: string; user: { id: string; email: string } } } = {},
): Promise<AppView> {
  const state = await ensureSandbox(projectId);
  if (state.status !== "ready") throw new AppViewError("The preview isn't running, so there's nothing to look at yet.");
  const width = Math.min(1920, Math.max(320, Math.round(opts.width ?? 1280)));
  const path = opts.path?.startsWith("/") ? opts.path : `/${opts.path ?? ""}`;
  const b = await browser();
  const context = await b.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  // Open the app already signed in: the Cloud client reads its session from localStorage.
  if (opts.session) {
    await context.addInitScript((s) => {
      try {
        localStorage.setItem("forge-cloud-session", s);
      } catch {}
    }, JSON.stringify(opts.session));
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(`Uncaught: ${e.message.slice(0, 300)}`));
  page.on("requestfailed", (r) => errors.push(`Request failed: ${r.url().slice(0, 200)}`));
  try {
    await page.goto(`http://127.0.0.1:${state.port}${path}`, { waitUntil: "load", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(600);
    const { title, scrollWidth } = await page.evaluate(() => ({ title: document.title, scrollWidth: document.documentElement.scrollWidth }));
    // Long pages are cut at three screens: enough to judge, cheap to send.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const shot = await page.screenshot({ type: "jpeg", quality: 70, clip: { x: 0, y: 0, width, height: Math.min(height, 2700) } });
    return { image: shot.toString("base64"), title, errors: [...new Set(errors)].slice(0, 10), overflowsX: scrollWidth > width + 1, scrollWidth };
  } finally {
    await context.close().catch(() => undefined);
  }
}
