"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { MANIFESTS, SIDEBAR_APPS } from "@/lib/iotx/manifests";
import type { ShellData } from "@/lib/iotx/shell";
import { useBrand } from "@/components/BrandProvider";
import { usePerms } from "../PermsProvider";
import { AppIcon, Icon, IxMark } from "../icons";
import Launcher, { appHref, openLauncher, useChatUnread } from "../Launcher";
import TopActions from "../TopActions";
import AppearanceSync from "../AppearanceSync";
import { PreviewBanner } from "../Shell";
import { TabLink, tabApp, tabPath, tabTitle } from "../tabs";
import { hookFrame, type FrameEvents } from "./hook";
import Omnibox, { focusOmnibox } from "./Omnibox";
import SpacesNav from "./SpacesNav";
import FloatingAI from "./FloatingAI";
import MentionPicker from "./MentionPicker";
import { NEW_TAB_URL, countVisit, serverState, tabStore, type Tab, type TabStore, type TabsState } from "./store";

const noop = () => () => {};
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The sidebar's collapsed state, remembered in this browser. */
const COLLAPSED = "iotx-collapsed";
const subscribeCollapsed = (cb: () => void) => {
  window.addEventListener("iotx:collapsed", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("iotx:collapsed", cb);
    window.removeEventListener("storage", cb);
  };
};
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED) === "1";
  } catch {
    return false;
  }
};

/** Where the address bar points on a top-level load: /tab?u=… (from Workspace) names the page. */
function hereNow() {
  const l = window.location;
  if (l.pathname === "/tab") return tabPath(new URLSearchParams(l.search).get("u") ?? "") ?? NEW_TAB_URL;
  return tabPath(l.pathname + l.search + l.hash) ?? NEW_TAB_URL;
}

export const SHORTCUTS: [string, string][] = [
  ["Alt+T", "New tab"],
  ["Alt+W", "Close tab"],
  ["Ctrl+Alt+→ / ←", "Next / previous tab"],
  ["Alt+1 … Alt+8", "Go to tab 1 to 8"],
  ["Alt+9", "Go to the last tab"],
  ["Ctrl+L or Alt+D", "Address bar"],
  ["Ctrl+K", "Search or ask (address bar)"],
  ["Alt+Enter", "Open the address bar's pick in a new tab"],
  ["Ctrl+J", "All apps"],
  ["Ctrl+click, middle click", "Open a link in a new tab"],
  ["Middle click a tab", "Close it"],
  ["Double-click the tab strip", "New tab"],
];

/** A tab's little icon: the app's colour and glyph, or a spinner while it loads. */
function Favicon({ tab, size = 16 }: { tab: Tab; size?: number }) {
  const a = tabApp(tab.url);
  if (tab.loading && tab.live) return <span className="ixb-spin" style={{ width: size, height: size }} aria-label="Loading" />;
  return (
    <span className="ixb-fav" style={{ width: size, height: size, background: a.color }} aria-hidden>
      <Icon name={a.icon} size={Math.round(size * 0.68)} />
    </span>
  );
}

/**
 * The suite as a browser, in the top window: a tab strip (drag to reorder,
 * middle click to close, right click for more, pinned tabs as icons), a
 * toolbar (back, forward, reload, the address bar, bell, launcher, avatar),
 * the apps in the left sidebar, and each tab's page in its own same-origin
 * iframe, kept loaded while you switch (up to MAX_LIVE tabs). The window's
 * address follows the active tab. On phones: a compact bar with a tab
 * switcher and the sidebar as a drawer.
 */
export default function Browser({ data, userId }: { data: ShellData; userId: string }) {
  const perms = usePerms();
  const brand = useBrand();
  const pathname = usePathname();
  const [initial] = useState(() => serverState(tabPath(pathname ?? "") ?? NEW_TAB_URL));
  const store = useMemo<TabStore | null>(() => (typeof window === "undefined" ? null : tabStore(userId, hereNow())), [userId]);
  const state: TabsState = useSyncExternalStore(store ? store.subscribe : noop, store ? store.get : () => initial, () => initial);
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [keys, setKeys] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const strip = useRef<HTMLDivElement>(null);
  const unread = useChatUnread(perms.opens("teamchat"));
  const { tabs } = state;
  const active = tabs.find((t) => t.id === state.active) ?? tabs[0];

  const winOf = useCallback((id: string) => {
    try {
      const w = frames.current.get(id)?.contentWindow;
      return w && w.location.origin === window.location.origin ? w : null;
    } catch {
      return null;
    }
  }, []);

  // Suite shortcuts, in the frame and (forwarded by the hook) inside a tab's page.
  const onKey = useCallback(
    (e: KeyboardEvent, inPage: boolean) => {
      if (!store) return false;
      const plainAlt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      const mod = (isMac() ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (plainAlt && e.code === "KeyT") return (store.newTab(), focusOmnibox(), true);
      if (plainAlt && e.code === "KeyW") return (store.close(store.state.active), true);
      if (plainAlt && e.code === "KeyD") return (focusOmnibox(), true);
      if (plainAlt && /^Digit[1-9]$/.test(e.code)) return (store.nth(Number(e.code.slice(5))), true);
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) return (store.cycle(e.key === "ArrowRight" ? 1 : -1), true);
      if (mod && (e.code === "KeyL" || e.code === "KeyK")) return (focusOmnibox(), true);
      // The launcher listens for Ctrl+J in this window itself; from inside a page, open it here.
      if (inPage && mod && e.code === "KeyJ") return (openLauncher(), true);
      return false;
    },
    [store],
  );

  const events = useCallback(
    (id: string): FrameEvents => ({
      report: (kind, url, title) => {
        if (/^\/login(\/|\?|$)/.test(url)) return void window.location.assign(url);
        store?.report(id, kind, tabPath(url) ?? url, tabTitle(title, url, brand.name));
      },
      navigate: (path) => store?.navigate(id, path),
      open: (path, background) => store?.open(path, { newTab: true, after: id, background }),
      key: (e) => onKey(e, true),
      loading: () => store?.setLoading(id, true),
      touch: () => {
        // A click inside the page closes the frame's menus, as a click anywhere else would.
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        setMenu(null);
      },
    }),
    [store, brand.name, onKey],
  );

  const onFrameLoad = (id: string) => {
    const f = frames.current.get(id);
    if (!f || !store) return;
    if (!hookFrame(f, events(id))) return store.setBlocked(id);
    const w = f.contentWindow!;
    const url = w.location.pathname + w.location.search + w.location.hash;
    if (/^\/login(\/|\?|$)/.test(url)) return void window.location.assign(url);
    store.report(id, "load", tabPath(url) ?? url, tabTitle(w.document.title, url, brand.name));
  };

  // The frame drives tabs' pages; pages and the frame's own menus open tabs through window.__iotxTabs.
  useEffect(() => {
    if (!store) return;
    const detach = store.attach({
      replace: (id, url) => {
        const w = winOf(id);
        if (!w) return false;
        w.location.replace(url);
        return true;
      },
      reload: (id) => {
        const w = winOf(id);
        if (!w) return false;
        w.location.reload();
        return true;
      },
    });
    const api = { open: (path: string, o: { newTab?: boolean; background?: boolean }) => store.open(path, { newTab: o.newTab, after: store.state.active, background: o.background }) };
    (window as unknown as { __iotxTabs?: typeof api }).__iotxTabs = api;
    // Pages inside tabs ask by postMessage: only from this origin, and only from one of our tabs.
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; url?: unknown; newTab?: unknown; background?: unknown } | null;
      if (!d || d.type !== "iotx:open" || typeof d.url !== "string") return;
      const from = [...frames.current.entries()].find(([, f]) => f.contentWindow === e.source)?.[0];
      if (!from) return;
      const path = tabPath(d.url);
      if (!path) return;
      if (d.newTab) store.open(path, { newTab: true, after: from, background: d.background === true });
      else store.navigate(from, path);
    };
    const onTop = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && onKey(e, false)) e.preventDefault();
    };
    // A theme or background change made in the frame reaches every open page.
    const onLook = (e: Event) => {
      for (const id of frames.current.keys()) {
        const w = winOf(id) as (Window & { __forgeApplyTheme?: () => void }) | null;
        w?.__forgeApplyTheme?.();
        w?.dispatchEvent(new CustomEvent("iotx:appearance", { detail: (e as CustomEvent).detail }));
      }
    };
    const onShortcuts = () => setKeys(true);
    window.addEventListener("message", onMsg);
    window.addEventListener("keydown", onTop);
    window.addEventListener("iotx:appearance", onLook);
    window.addEventListener("iotx:shortcuts", onShortcuts);
    return () => {
      detach();
      delete (window as unknown as { __iotxTabs?: unknown }).__iotxTabs;
      window.removeEventListener("message", onMsg);
      window.removeEventListener("keydown", onTop);
      window.removeEventListener("iotx:appearance", onLook);
      window.removeEventListener("iotx:shortcuts", onShortcuts);
    };
  }, [store, winOf, onKey]);

  // The window's address and title follow the active tab, so a refresh or a shared link reopens it.
  const activeUrl = active?.url;
  const activeTitle = active?.title;
  useEffect(() => {
    if (!store || !activeUrl) return;
    const l = window.location;
    if (l.pathname + l.search + l.hash !== activeUrl) window.history.replaceState(window.history.state, "", activeUrl);
    countVisit(userId, activeUrl);
  }, [store, activeUrl, userId]);
  useEffect(() => {
    if (activeTitle) document.title = activeTitle === brand.name ? brand.name : `${activeTitle} – ${brand.shortName}`;
  }, [activeTitle, brand.name, brand.shortName]);
  // Keys go to the page of the tab you switch to.
  const activeId = active?.id;
  useEffect(() => {
    if (!activeId || document.activeElement?.closest?.(".ixb-omni")) return;
    frames.current.get(activeId)?.contentWindow?.focus();
  }, [activeId]);

  // Menus close on Escape and outside clicks.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".ixb-menu")) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    window.addEventListener("blur", () => setMenu(null), { once: true });
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const toggleCollapse = () => {
    try {
      localStorage.setItem(COLLAPSED, collapsed ? "0" : "1");
    } catch {}
    window.dispatchEvent(new Event("iotx:collapsed"));
  };
  const newTab = () => {
    store?.newTab();
    setSwitcher(false);
    focusOmnibox();
  };
  const openHref = (href: string, newTabToo: boolean) => {
    const path = tabPath(href);
    if (!path) return void window.open(href, "_blank", "noopener,noreferrer");
    store?.open(path, { newTab: newTabToo, after: store.state.active });
  };

  // Drag a tab to reorder it: the pointer's position among the other tabs' midpoints is its new place.
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || !store) return;
    store.activate(id);
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 6) return;
      moved = true;
      setDragging(id);
      const others = [...(strip.current?.querySelectorAll<HTMLElement>("[data-tab]") ?? [])].filter((el) => el.dataset.tab !== id);
      const to = others.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 < ev.clientX;
      }).length;
      store.move(id, to);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const here = active ? tabApp(active.url) : null;
  const activeChat = active?.url.match(/^\/home\/chat\?(?:.*&)?chat=([^&#]+)/)?.[1] ?? null;
  // Recent AI chats: the server's list, plus chats open in tabs that are newer than it.
  const chats = [...data.recentChats];
  for (const t of tabs) {
    const id = t.url.match(/^\/home\/chat\?(?:.*&)?chat=([^&#]+)/)?.[1];
    if (id && !chats.some((c) => c.id === id)) chats.unshift({ id, title: t.title });
  }
  const canAsk = perms.can("home.ask");
  const roleName = perms.preview?.name ?? perms.roles[0]?.name ?? "Member";
  const sideApps = SIDEBAR_APPS.filter((id) => id !== "chat" && perms.opens(id))
    .map((id) => MANIFESTS.find((m) => m.id === id))
    .filter((m): m is (typeof MANIFESTS)[number] => !!m);
  const closeDrawer = () => setDrawer(false);
  const menuTab = menu ? tabs.find((t) => t.id === menu.id) : undefined;
  const menuIdx = menuTab ? tabs.indexOf(menuTab) : -1;
  // Iframes stay in creation order, so moving a tab never moves (and reloads) its page.
  const liveTabs = mounted ? tabs.filter((t) => t.live).sort((a, b) => a.seq - b.seq) : [];

  return (
    <div className={`ix ixb ${collapsed ? "collapsed" : ""} ${drawer ? "drawer" : ""}`} style={perms.preview ? { paddingTop: 34 } : undefined}>
      <PreviewBanner />
      <AppearanceSync appearance={data.appearance} />
      <Launcher />

      <header
        className="ixb-strip"
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest(".ixb-tab, button")) newTab();
        }}
      >
        <div className="ixb-tabs" role="tablist" aria-label="Tabs" ref={strip}>
          {tabs.map((t, i) => {
            const on = t.id === active?.id;
            return (
              <div
                key={t.id}
                data-tab={t.id}
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                title={t.title}
                className={`ixb-tab ${on ? "on" : ""} ${t.pinned ? "pinned" : ""} ${dragging === t.id ? "drag" : ""} ${tabs[i + 1]?.id === active?.id ? "before-on" : ""}`}
                onPointerDown={(e) => startDrag(e, t.id)}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => e.button === 1 && store?.close(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ id: t.id, x: e.clientX, y: e.clientY });
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") store?.cycle(e.key === "ArrowRight" ? 1 : -1);
                  if (e.key === "Delete") store?.close(t.id);
                }}
              >
                {on && <span className="ixb-foot l" aria-hidden />}
                {on && <span className="ixb-foot r" aria-hidden />}
                <Favicon tab={t} />
                {!t.pinned && <span className="ixb-tab-title">{t.title}</span>}
                {!t.pinned && (
                  <button
                    className="ixb-x"
                    aria-label={`Close ${t.title}`}
                    title="Close tab (Alt+W)"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      store?.close(t.id);
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            );
          })}
          <button className="ixb-new" onClick={newTab} aria-label="New tab (Alt+T)" title="New tab (Alt+T)">
            <Icon name="add" size={16} />
          </button>
        </div>
      </header>

      <div className="ixb-toolbar">
        <button className="ix-iconbtn ixb-phone" onClick={() => setDrawer(true)} aria-label="Open sidebar">
          <Icon name="burger" size={18} />
        </button>
        <button className="ixb-nav" onClick={() => store?.back()} disabled={!active || active.idx === 0} aria-label="Back" title="Back">
          <Icon name="back" size={17} />
        </button>
        <button className="ixb-nav ixb-desk" onClick={() => store?.forward()} disabled={!active || active.idx >= active.hist.length - 1} aria-label="Forward" title="Forward">
          <Icon name="forward" size={17} />
        </button>
        <button className="ixb-nav ixb-desk" onClick={() => store?.reload()} aria-label="Reload" title="Reload this tab">
          <Icon name="reload" size={16} />
        </button>
        <Omnibox tab={active} onOpen={openHref} />
        <button className="ixb-count ixb-phone" onClick={() => setSwitcher(true)} aria-label={`Tabs: ${tabs.length} open`} title="Tabs">
          <span>{tabs.length > 99 ? "99+" : tabs.length}</span>
        </button>
        <div className="ixb-actions">
          <TopActions data={data} />
        </div>
      </div>

      <div className="ixb-body">
        <div className="ix-drawer-scrim ixb-scrim" onClick={closeDrawer} aria-hidden />
        <aside className="ixb-side" aria-label="Apps">
          <div className="ixb-side-head">
            <button className="ix-iconbtn ixb-desk" onClick={toggleCollapse} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              <Icon name="burger" size={18} />
            </button>
            <TabLink href="/home" aria-label={`${brand.name}: new tab page`} className="ix-brand-link" onClick={closeDrawer}>
              <IxMark size={24} />
              <b>
                {brand.name.startsWith(brand.shortName + " ") ? (
                  <>
                    {brand.shortName} <span>{brand.name.slice(brand.shortName.length + 1)}</span>
                  </>
                ) : (
                  brand.name
                )}
              </b>
            </TabLink>
            <span style={{ flex: 1 }} />
            <button className="ix-iconbtn ixb-phone" onClick={closeDrawer} aria-label="Close sidebar">
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="ix-side-scroll">
            <div className="ix-navlist">
              <TabLink href="/home" className={`ix-nav ${here?.id === "newtab" ? "on" : ""}`} title="Home" onClick={closeDrawer}>
                <span className="ico">
                  <Icon name="home" size={17} />
                </span>
                <span className="label">Home</span>
              </TabLink>
              {canAsk && (
                <TabLink href="/home/chat?new=1" className={`ix-nav ${here?.id === "chat" && !activeChat ? "on" : ""}`} title="AI Chat" onClick={closeDrawer}>
                  <span className="ico">
                    <Icon name="chat" size={17} />
                  </span>
                  <span className="label">AI Chat</span>
                </TabLink>
              )}
            </div>
            {canAsk && chats.length > 0 && (
              <>
                <div className="ix-sect">Recent chats</div>
                <div className="ix-navlist ix-recentchats">
                  {chats.slice(0, 6).map((c) => (
                    <TabLink key={c.id} href={`/home/chat?chat=${c.id}`} className={`ix-nav ${activeChat === c.id ? "on" : ""}`} title={c.title} onClick={closeDrawer}>
                      <span className="ico" style={{ color: "var(--ix-muted)" }}>
                        <Icon name="chatline" size={15} />
                      </span>
                      <span className="label">{c.title}</span>
                    </TabLink>
                  ))}
                </div>
              </>
            )}
            <SpacesNav activeUrl={active?.url} onNavigate={closeDrawer} />
            <div className="ix-sect">Apps</div>
            <div className="ix-navlist" aria-label="Apps">
              {sideApps.map((m) => (
                <TabLink key={m.id} href={appHref(m.id)} className={`ix-nav ${here?.id === m.id ? "on" : ""}`} title={m.status === "soon" ? `${m.name} (coming soon)` : `${m.name} (Ctrl+click: new tab)`} data-app={m.id} onClick={closeDrawer}>
                  <span className="ico">
                    <AppIcon icon={m.icon} color={m.color} size={22} />
                  </span>
                  <span className="label">
                    {m.name}
                    {m.status === "soon" && <span className="dim"> · Soon</span>}
                  </span>
                  {m.id === "teamchat" && unread > 0 && <span className="ix-badge ixb-side-badge">{unread > 99 ? "99+" : unread}</span>}
                </TabLink>
              ))}
            </div>
            <div className="ix-sect ix-sect-line" aria-hidden />
            <div className="ix-navlist">
              {perms.can("builder.open") && (
                <TabLink href="/data-hub" className={`ix-nav ${here?.id === "datahub" ? "on" : ""}`} title="Data Hub: apps reading each other's data" onClick={closeDrawer}>
                  <span className="ico">
                    <Icon name="link" size={17} />
                  </span>
                  <span className="label">Data Hub</span>
                </TabLink>
              )}
              <TabLink href="/people" className={`ix-nav ${here?.id === "people" ? "on" : ""}`} title="People: company structure and employees" onClick={closeDrawer}>
                <span className="ico">
                  <Icon name="people" size={17} />
                </span>
                <span className="label">People</span>
              </TabLink>
              <TabLink href="/settings/preferences" className={`ix-nav ${here?.id === "settings" ? "on" : ""}`} title="Settings" onClick={closeDrawer}>
                <span className="ico">
                  <Icon name="settings" size={17} />
                </span>
                <span className="label">Settings</span>
              </TabLink>
              {(perms.canManage || perms.can("admin.open")) && (
                <TabLink href="/admin/roles" className={`ix-nav ${here?.id === "admin" ? "on" : ""}`} title="Admin" onClick={closeDrawer}>
                  <span className="ico">
                    <Icon name="admin" size={17} />
                  </span>
                  <span className="label">Admin</span>
                </TabLink>
              )}
            </div>
          </div>
          <div className="ix-side-foot ix-hint" title={`${roleName} · ${data.workspace.name}`}>
            <span className="label">
              {roleName} · {data.workspace.name}
            </span>
          </div>
        </aside>

        <main className="ixb-view" aria-label={active?.title}>
          {liveTabs.map((t) => {
            const on = t.id === active?.id;
            return (
              <iframe
                key={`${t.id}:${t.gen}`}
                ref={(el) => {
                  if (!el) return;
                  frames.current.set(t.id, el);
                  return () => {
                    if (frames.current.get(t.id) === el) frames.current.delete(t.id);
                  };
                }}
                src={t.src}
                title={t.title}
                name={`iotx-tab-${t.id}`}
                className={`ixb-frame ${on ? "on" : ""}`}
                allow="camera; microphone; display-capture; fullscreen; clipboard-read; clipboard-write; autoplay; geolocation"
                inert={!on}
                aria-hidden={!on}
                tabIndex={on ? 0 : -1}
                onLoad={() => onFrameLoad(t.id)}
              />
            );
          })}
          {active?.blocked && (
            <div className="ixb-blocked">
              <Icon name="globe" size={28} />
              <h2>This page went to another site</h2>
              <p>Tabs show {brand.shortName} pages only. Other sites open in your browser&apos;s own tabs.</p>
              <button className="ix-btn primary" onClick={() => store?.navigate(active.id, active.hist[active.idx] ?? NEW_TAB_URL)}>
                Back to {tabApp(active.hist[active.idx] ?? NEW_TAB_URL).name}
              </button>
            </div>
          )}
        </main>
      </div>

      <MentionPicker tabs={tabs} winOf={winOf} />

      {store && active && (
        <FloatingAI
          tabs={tabs}
          activeId={active.id}
          winOf={winOf}
          openTab={(url) => store.open(url, { newTab: true, after: store.state.active })}
          activate={(id) => store.activate(id)}
          reload={(id) => store.reload(id)}
        />
      )}

      {menu && menuTab && (
        <div className="ix-pop ixb-menu" role="menu" aria-label="Tab menu" style={{ position: "fixed", left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 250), top: menu.y + 4, right: "auto", width: 240 }}>
          <MenuItem icon="add" label="New tab to the right" onClick={() => (setMenu(null), store?.open(NEW_TAB_URL, { newTab: true, after: menuTab.id }), focusOmnibox())} />
          <div className="ixb-menu-line" />
          <MenuItem icon="reload" label="Reload" onClick={() => (setMenu(null), store?.reload(menuTab.id))} />
          <MenuItem icon="dup" label="Duplicate" onClick={() => (setMenu(null), store?.duplicate(menuTab.id))} />
          <MenuItem icon="pin" label={menuTab.pinned ? "Unpin" : "Pin"} onClick={() => (setMenu(null), store?.togglePin(menuTab.id))} />
          <div className="ixb-menu-line" />
          <MenuItem icon="close" label="Close" kbd="Alt+W" onClick={() => (setMenu(null), store?.close(menuTab.id))} />
          <MenuItem label="Close other tabs" disabled={tabs.length < 2} onClick={() => (setMenu(null), store?.closeOthers(menuTab.id))} />
          <MenuItem label="Close tabs to the right" disabled={menuIdx >= tabs.length - 1} onClick={() => (setMenu(null), store?.closeRight(menuTab.id))} />
        </div>
      )}

      {switcher && (
        <div className="ixb-switcher" role="dialog" aria-label="Tabs">
          <div className="ixb-switcher-bar">
            <button className="ix-iconbtn" onClick={newTab} aria-label="New tab">
              <Icon name="add" size={18} />
            </button>
            <b>{tabs.length === 1 ? "1 tab" : `${tabs.length} tabs`}</b>
            <span className="ix-sp" />
            <button className="ix-btn" onClick={() => setSwitcher(false)}>
              Done
            </button>
          </div>
          <div className="ixb-grid">
            {tabs.map((t) => {
              const a = tabApp(t.url);
              return (
                <div key={t.id} className={`ixb-card ${t.id === active?.id ? "on" : ""}`}>
                  <button
                    className="ixb-card-main"
                    onClick={() => {
                      store?.activate(t.id);
                      setSwitcher(false);
                    }}
                    aria-label={`${t.title}${t.id === active?.id ? " (current)" : ""}`}
                  >
                    <span className="ixb-card-top">
                      <Favicon tab={t} size={16} />
                      <span>{t.title}</span>
                    </span>
                    <span className="ixb-card-body" style={{ background: `color-mix(in srgb, var(--ix-hover) 70%, transparent)` }}>
                      <AppIcon icon={a.icon} color={a.color} size={44} />
                      <small>{t.url}</small>
                    </span>
                  </button>
                  <button className="ixb-card-x" onClick={() => store?.close(t.id)} aria-label={`Close ${t.title}`}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {keys && (
        <div className="ix" style={{ background: "none" }}>
          <div className="ix-scrim" onClick={() => setKeys(false)} aria-hidden />
          <div className="ix-launcher ixb-keys" role="dialog" aria-label="Keyboard shortcuts">
            <div style={{ display: "flex", alignItems: "center" }}>
              <h4 style={{ flex: 1 }}>Keyboard shortcuts</h4>
              <button className="ix-iconbtn" onClick={() => setKeys(false)} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            <p className="sub2">Your browser keeps Ctrl+T, Ctrl+W and Ctrl+Tab for its own tabs, so {brand.shortName}&apos;s tabs use Alt.</p>
            <table className="ixb-keytable">
              <tbody>
                {SHORTCUTS.map(([k, what]) => (
                  <tr key={k}>
                    <td>
                      <kbd>{isMac() ? k.replace(/Ctrl/g, "⌘") : k}</kbd>
                    </td>
                    <td>{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, kbd, onClick, disabled }: { icon?: string; label: string; kbd?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="ix-menuitem" role="menuitem" onClick={onClick} disabled={disabled}>
      <span style={{ width: 16, display: "inline-grid", placeItems: "center" }}>{icon && <Icon name={icon} size={14} />}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {kbd && <span className="ix-hint">{kbd}</span>}
    </button>
  );
}
