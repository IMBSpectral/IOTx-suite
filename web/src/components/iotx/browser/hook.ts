import { tabPath } from "../tabs";

/**
 * Wires one tab's page to the frame. Tabs are same-origin iframes, so the
 * frame reads and hooks the page directly (no code is needed in the page):
 * - history: pushState becomes replaceState plus a report, so every tab keeps
 *   its own back/forward list in the frame instead of sharing the browser's
 *   joint history (where Back could move another tab);
 * - the title: watched in <head>;
 * - links: Ctrl/Cmd/Shift/middle click, target=_blank and window.open of a
 *   suite page open a new suite tab; a plain link to another suite or
 *   Workspace page opens in this tab; another site opens in a real browser
 *   tab (tabs never show other sites); API links (sign-in with Google, sign
 *   out) run in the top window;
 * - suite shortcuts (Alt+T, Alt+W…) pressed inside the page.
 */
export type FrameEvents = {
  report(kind: "push" | "replace" | "load" | "title", url: string, title: string): void;
  navigate(path: string): void;
  /** A new tab; in the background for Ctrl/Cmd/middle clicks, as in Chrome. */
  open(path: string, background?: boolean): void;
  key(e: KeyboardEvent): boolean;
  loading(): void;
  /** A pointer went down inside the page: close the frame's menus. */
  touch(): void;
};

type Hooked = Window & { __iotxHook?: boolean };

/** Returns false when the page isn't readable (it's on another site). */
export function hookFrame(iframe: HTMLIFrameElement, ev: FrameEvents): boolean {
  let win: Hooked;
  let doc: Document;
  try {
    win = iframe.contentWindow as Hooked;
    doc = win.document;
    if (win.location.origin !== window.location.origin) return false;
  } catch {
    return false;
  }
  const here = () => win.location.pathname + win.location.search + win.location.hash;
  if (win.__iotxHook) return true;
  win.__iotxHook = true;

  const H = win.history;
  const replace = H.replaceState.bind(H);
  H.pushState = function (state: unknown, unused: string, url?: string | URL | null) {
    replace(state, unused, url);
    ev.report("push", here(), doc.title);
  };
  H.replaceState = function (state: unknown, unused: string, url?: string | URL | null) {
    replace(state, unused, url);
    ev.report("replace", here(), doc.title);
  };
  win.addEventListener("hashchange", () => ev.report("replace", here(), doc.title));

  if (doc.head) new MutationObserver(() => ev.report("title", here(), doc.title)).observe(doc.head, { subtree: true, childList: true, characterData: true });

  const open = win.open.bind(win);
  win.open = (url?: string | URL, target?: string, features?: string) => {
    if (url === undefined || url === null || url === "") return open(url, target, features);
    const path = tabPath(String(url), win.location.href);
    // A popup (sized, or asked for) stays a real window: sign-in flows need it.
    if (path && target !== "_self" && !(features && /popup|width|height/i.test(features))) {
      ev.open(path);
      return null;
    }
    return open(url, target, features);
  };

  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button > 1) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.hasAttribute("download")) return;
    const raw = a.getAttribute("href") ?? "";
    if (raw.startsWith("#") || /^(mailto|tel|sms|javascript|blob|data):/i.test(raw)) return;
    let abs: URL;
    try {
      abs = new URL(a.href, win.location.href);
    } catch {
      return;
    }
    const target = (a.getAttribute("target") || "").toLowerCase();
    const newTab = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey || (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent");
    if (abs.origin !== window.location.origin) {
      e.preventDefault();
      window.open(abs.href, "_blank", "noopener,noreferrer");
      return;
    }
    const path = tabPath(abs.href);
    if (!path) {
      // An API or a file: a new tab means a real browser tab (files); otherwise the whole window
      // (Google sign-in, sign out), which comes back to the suite with the page as a tab.
      if (newTab) {
        e.preventDefault();
        window.open(abs.href, "_blank", "noopener");
      } else if (e.button === 0) {
        e.preventDefault();
        window.location.assign(abs.href);
      }
      return;
    }
    // Same page, another #section: the browser scrolls.
    if (!newTab && abs.pathname === win.location.pathname && abs.search === win.location.search && abs.hash) return;
    e.preventDefault();
    if (newTab) ev.open(path, e.button === 1 || e.ctrlKey || e.metaKey);
    else ev.navigate(path);
  };
  win.addEventListener("click", onClick);
  win.addEventListener("auxclick", onClick);
  win.addEventListener("mousedown", (e) => e.button === 1 && (e.target as Element | null)?.closest?.("a[href]") && e.preventDefault());
  win.addEventListener("pointerdown", () => ev.touch());
  win.addEventListener("keydown", (e) => {
    if (!e.defaultPrevented && ev.key(e)) e.preventDefault();
  });
  win.addEventListener("pagehide", () => ev.loading());
  return true;
}
