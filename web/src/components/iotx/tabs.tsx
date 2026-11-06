"use client";

import Link from "next/link";
import { useEffect } from "react";
import { MANIFESTS } from "@/lib/iotx/manifests";

/**
 * Suite tabs: the suite is a browser, and every page opens in a tab inside it
 * (components/iotx/browser). These helpers work in the top window (the frame)
 * and inside a tab's page alike.
 */

/** Same-origin paths that aren't pages for a tab: APIs, sign-in, files, published sites, public Workspace pages. */
const NOT_A_PAGE =
  /^\/(?:api|login|_next|hosted|shared|versions|live|oauth|scim|cloud)(?:\/|$)|^\/workspace\/(?:api|auth|embed|rsvp|book|chat\/guest)(?:\/|$)|\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|csv|tsv|xlsx?|docx?|pptx?|json|txt|md|js|css|mp4|webm|mp3|wav)$/i;

/** The tab path (path + query + hash) for an href, or null when it isn't a suite page (another site, an API, a file). */
export function tabPath(href: string, base?: string): string | null {
  if (typeof window === "undefined") return href.startsWith("/") && !href.startsWith("//") ? href : null;
  let u: URL;
  try {
    u = new URL(href, base ?? window.location.href);
  } catch {
    return null;
  }
  if (u.origin !== window.location.origin || NOT_A_PAGE.test(u.pathname)) return null;
  return (u.pathname === "/" ? "/home" : u.pathname) + u.search + u.hash;
}

/** True in a page that is showing inside a suite tab. */
export const inTab = () => typeof window !== "undefined" && window.self !== window.top;

type TabsApi = { open(path: string, opts: { newTab?: boolean; background?: boolean }): void };

/**
 * Open a suite page in a tab: the current tab, or a new one. Inside a tab the
 * page asks the frame (postMessage, same origin only); in the frame it goes
 * straight to the tab strip. Another site opens in a real browser tab.
 */
export function openInSuite(href: string, opts: { newTab?: boolean; background?: boolean } = {}) {
  if (/^(mailto|tel):/i.test(href)) return void (window.location.href = href);
  const path = tabPath(href);
  if (!path) return void window.open(href, "_blank", "noopener,noreferrer");
  if (inTab()) return window.top!.postMessage({ type: "iotx:open", url: path, newTab: !!opts.newTab, background: !!opts.background }, window.location.origin);
  const api = (window as unknown as { __iotxTabs?: TabsApi }).__iotxTabs;
  if (api) api.open(path, opts);
  else window.location.assign(path);
}

/** Workspace (another process under /workspace): never a client-side route. */
const isWorkspace = (href: string) => href === "/workspace" || href.startsWith("/workspace/") || href.startsWith("/workspace?");

/**
 * A link to a suite page. A click opens it in the current tab, Ctrl/Cmd/Shift
 * or middle click in a new suite tab. Inside a tab, same-app links keep
 * client-side navigation; from the frame (sidebar, menus, bell) the frame
 * drives the tab.
 */
export function TabLink({ href, children, onClick, ...rest }: Omit<React.ComponentProps<typeof Link>, "href"> & { href: string }) {
  // Ctrl/Cmd and middle click open a background tab, as in Chrome; Shift a foreground one.
  const go = (e: React.MouseEvent<HTMLAnchorElement>, newTab: boolean, background = false) => {
    if (/^(mailto|tel):/i.test(href)) return;
    // Inside a tab, a plain click on one of this app's pages is an ordinary Next.js navigation.
    if (!newTab && inTab() && href.startsWith("/") && !isWorkspace(href)) return;
    e.preventDefault();
    openInSuite(href, { newTab, background });
  };
  return (
    <Link
      href={href}
      prefetch={false}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) go(e, e.ctrlKey || e.metaKey || e.shiftKey, e.ctrlKey || e.metaKey);
      }}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        onClick?.(e);
        go(e, true, true);
      }}
    >
      {children}
    </Link>
  );
}

/** What a tab shows for a route: its app's icon, colour and name. */
export type TabApp = { id: string; name: string; icon: string; color: string };
const app = (id: string, name?: string): TabApp | null => {
  const m = MANIFESTS.find((x) => x.id === id);
  return m ? { id: m.id, name: name ?? m.name, icon: m.icon, color: m.color } : null;
};
const ROUTES: [RegExp, string][] = [
  [/^\/home\/chat(\/|$)/, "chat"],
  [/^\/(dashboard|projects|assistant|chats|files|automations|help|rewards|vault|templates)(\/|$)/, "builder"],
  [/^\/docs(\/|$)/, "docs"],
  [/^\/sheets(\/|$)/, "sheets"],
  [/^\/slides(\/|$)/, "slides"],
  [/^\/mail(\/|$)/, "mail"],
  [/^\/drive(\/|$)/, "files"],
  [/^\/knowledge(\/|$)/, "read"],
  [/^\/admin(\/|$)/, "admin"],
  [/^\/workspace\/calendar(\/|$)/, "calendar"],
  [/^\/workspace\/tasks(\/|$)/, "tasks"],
  [/^\/workspace\/chat(\/|$)/, "teamchat"],
  [/^\/workspace\/meet(\/|$)/, "meetings"],
];
export const NEW_TAB: TabApp = { id: "newtab", name: "New Tab", icon: "home", color: "linear-gradient(135deg, var(--accent), var(--accent-2))" };
export function tabApp(url: string): TabApp {
  const path = url.split(/[?#]/)[0];
  if (path === "/home" || path === "/") return NEW_TAB;
  if (path === "/settings" || path.startsWith("/settings/")) return { id: "settings", name: "Settings", icon: "settings", color: "#6a6e8a" };
  if (path === "/data-hub") return { id: "datahub", name: "Data Hub", icon: "link", color: "linear-gradient(135deg,#4f46e5,#2dd4bf)" };
  if (path === "/people" || path.startsWith("/people/")) return { id: "people", name: "People", icon: "people", color: "linear-gradient(135deg,#0891b2,#6366f1)" };
  if (path === "/spaces" || path.startsWith("/spaces/")) return { id: "spaces", name: "Dashboard", icon: "dashboard", color: "linear-gradient(135deg,#0ea5e9,#6366f1)" };
  const soon = path.match(/^\/apps\/([a-z0-9-]+)/);
  if (soon) return app(soon[1]) ?? NEW_TAB;
  const hit = ROUTES.find(([re]) => re.test(path));
  return (hit && app(hit[1])) || { id: "page", name: path.split("/").filter(Boolean)[0]?.replace(/^\w/, (c) => c.toUpperCase()) ?? "Page", icon: "globe", color: "#6a6e8a" };
}

/**
 * A tab's title: the page's own document.title, without the suite's name, or
 * its app's name when the page doesn't set one.
 */
export function tabTitle(docTitle: string, url: string, brandName: string) {
  const t = docTitle
    .replace(new RegExp(`\\s*[·|–-]\\s*${brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "")
    .trim();
  return !t || t === brandName ? tabApp(url).name : t;
}

/** Sets the page's title (the tab's title in the suite) while it's shown. */
export function useTabTitle(raw: string | null | undefined) {
  // The browser stores a title with its spaces squeezed (a line break or double space
  // becomes one space). Compare and set that form: comparing the raw name never matched,
  // so the watcher below reset the title forever and froze the page (a project named
  // from a two-line prompt, Nov 2026).
  const title = raw?.replace(/\s+/g, " ").trim();
  useEffect(() => {
    if (!title) return;
    document.title = title;
    // Next.js streams the route's metadata <title> in later; keep ours while this page is shown.
    const keep = new MutationObserver(() => {
      if (document.title !== title) document.title = title;
    });
    keep.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => keep.disconnect();
  }, [title]);
}
