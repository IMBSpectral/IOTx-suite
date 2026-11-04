import { tabApp, tabPath } from "../tabs";

/**
 * The suite's tabs, like a browser's: each tab is one page in a same-origin
 * iframe with its own back/forward list. Saved per person in localStorage
 * (url, title, pinned, order, active) and restored on the next visit.
 * Only MAX_LIVE tabs keep their page loaded; older inactive ones are unloaded
 * and load again when focused (like Chrome's memory saver).
 */
export type Tab = {
  id: string;
  /** Creation order: iframes are rendered in this order so reordering tabs never moves (reloads) one. */
  seq: number;
  url: string;
  title: string;
  pinned: boolean;
  /** The page is loaded (its iframe is mounted). */
  live: boolean;
  used: number;
  hist: string[];
  idx: number;
  /** The iframe's src and key: bumping gen remounts it at src. */
  src: string;
  gen: number;
  loading: boolean;
  /** The page went to another site, which a tab can't show. */
  blocked?: boolean;
};
export type TabsState = { tabs: Tab[]; active: string };

export const MAX_LIVE = 12;
export const NEW_TAB_URL = "/home";
const VERSION = 1;

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const make = (url: string, title?: string, pinned = false, live = false): Tab => ({
  id: newId(),
  seq: seq,
  url,
  title: title || tabApp(url).name,
  pinned,
  live,
  used: live ? Date.now() : 0,
  hist: [url],
  idx: 0,
  src: url,
  gen: 0,
  loading: live,
});

/** The tabs for the first server render: just the page in the address bar. */
export function serverState(url: string): TabsState {
  const t = { ...make(url), id: "t0", seq: 0 };
  return { tabs: [t], active: t.id };
}

/** What a frame driver does to a tab's iframe; the component supplies it. */
export type Driver = {
  /** Load a url in a mounted tab without adding a browser history entry. False when the page can't be reached. */
  replace(id: string, url: string): boolean;
  reload(id: string): boolean;
};

export class TabStore {
  state: TabsState;
  private listeners = new Set<() => void>();
  private pending = new Map<string, string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private driver: Driver | null = null;

  constructor(
    private key: string,
    here: string,
  ) {
    this.state = this.restore(here);
    this.enforceCap();
  }

  /** The component that owns the iframes drives them; returns the detach. */
  attach(d: Driver) {
    this.driver = d;
    return () => {
      if (this.driver === d) this.driver = null;
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  get = () => this.state;

  private set(next: TabsState) {
    this.state = next;
    for (const l of this.listeners) l();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250);
  }
  private patch(id: string, p: Partial<Tab> | ((t: Tab) => Partial<Tab>)) {
    this.set({ ...this.state, tabs: this.state.tabs.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)) });
  }
  tab = (id: string) => this.state.tabs.find((t) => t.id === id);
  get activeTab() {
    return this.tab(this.state.active) ?? this.state.tabs[0];
  }

  // ── Saving and restoring

  private restore(here: string): TabsState {
    let saved: { v: number; tabs: { url: string; title: string; pinned?: boolean }[]; active: number } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(this.key) || "null");
    } catch {}
    const tabs = (saved?.v === VERSION && Array.isArray(saved.tabs) ? saved.tabs : [])
      .map((t) => ({ ...t, url: typeof t.url === "string" ? tabPath(t.url) : null }))
      .filter((t): t is { url: string; title: string; pinned?: boolean } => !!t.url)
      .slice(0, 60)
      .map((t) => make(t.url, String(t.title ?? "").slice(0, 200), !!t.pinned));
    tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    let active = tabs[Math.min(Math.max(saved?.active ?? 0, 0), tabs.length - 1)];
    // The address bar wins: a shared link or a refresh opens (or finds) that page.
    // Plain Home just brings the last session back.
    const homeOnly = here === NEW_TAB_URL || here === "/";
    if (!homeOnly || !tabs.length) {
      const same = tabs.find((t) => t.url === here);
      if (same) active = same;
      else {
        active = make(here);
        tabs.push(active);
      }
    }
    active.live = true;
    active.loading = true;
    active.used = Date.now();
    return { tabs, active: active.id };
  }

  save() {
    try {
      const { tabs, active } = this.state;
      localStorage.setItem(this.key, JSON.stringify({ v: VERSION, tabs: tabs.map((t) => ({ url: t.url, title: t.title, pinned: t.pinned || undefined })), active: tabs.findIndex((t) => t.id === active) }));
    } catch {}
  }

  // ── Opening, switching, closing

  /** Open a page: in the current tab, or a new tab (after `after`, else at the end). */
  open(url: string, opts: { newTab?: boolean; after?: string; background?: boolean } = {}) {
    if (!opts.newTab) return this.navigate(this.state.active, url);
    // A background tab loads too (as in Chrome), so it's ready when you get to it.
    const t = make(url, undefined, false, true);
    const tabs = [...this.state.tabs];
    const at = opts.after ? tabs.findIndex((x) => x.id === opts.after) : -1;
    if (at >= 0) {
      // Like Chrome: after the opener and the tabs it opened just before.
      let i = at + 1;
      while (i < tabs.length && tabs[i].pinned) i++;
      tabs.splice(i, 0, t);
    } else tabs.push(t);
    this.set({ tabs, active: opts.background ? this.state.active : t.id });
    this.enforceCap();
    return t.id;
  }

  newTab() {
    return this.open(NEW_TAB_URL, { newTab: true });
  }

  activate(id: string) {
    const t = this.tab(id);
    if (!t) return;
    this.set({
      tabs: this.state.tabs.map((x) => (x.id === id ? { ...x, used: Date.now(), live: true, loading: x.live ? x.loading : true, src: x.live ? x.src : x.url, gen: x.live ? x.gen : x.gen + 1 } : x)),
      active: id,
    });
    this.enforceCap();
  }

  /** Switch by offset (Ctrl+Alt+→/←) or to the n-th tab (Alt+1..8; Alt+9 is the last). */
  cycle(d: number) {
    const { tabs, active } = this.state;
    const i = tabs.findIndex((t) => t.id === active);
    this.activate(tabs[(i + d + tabs.length) % tabs.length].id);
  }
  nth(n: number) {
    const { tabs } = this.state;
    const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (t) this.activate(t.id);
  }

  close(id: string) {
    const { tabs, active } = this.state;
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) {
      // Closing the last tab leaves a New Tab, as a browser window would before it closes.
      const t = make(NEW_TAB_URL, undefined, false, true);
      return this.set({ tabs: [t], active: t.id });
    }
    if (id !== active) return this.set({ tabs: rest, active });
    const next = rest[Math.min(i, rest.length - 1)];
    this.set({ tabs: rest, active: next.id });
    this.activate(next.id);
  }
  closeOthers(id: string) {
    const keep = this.state.tabs.filter((t) => t.id === id || t.pinned);
    this.set({ tabs: keep, active: id });
    this.activate(id);
  }
  closeRight(id: string) {
    const { tabs, active } = this.state;
    const i = tabs.findIndex((t) => t.id === id);
    const keep = tabs.slice(0, i + 1);
    const stillActive = keep.some((t) => t.id === active);
    this.set({ tabs: keep, active: stillActive ? active : id });
    if (!stillActive) this.activate(id);
  }
  duplicate(id: string) {
    const t = this.tab(id);
    if (!t) return;
    const nt = this.open(t.url, { newTab: true, after: id });
    if (nt) this.patch(nt, { title: t.title });
  }
  togglePin(id: string) {
    const t = this.tab(id);
    if (!t) return;
    const rest = this.state.tabs.filter((x) => x.id !== id);
    const pinnedCount = rest.filter((x) => x.pinned).length;
    const moved = { ...t, pinned: !t.pinned };
    // Pinned tabs sit together at the start; pinning moves a tab to the end of them, unpinning just after.
    rest.splice(pinnedCount, 0, moved);
    this.set({ ...this.state, tabs: rest });
  }
  /** Drag to reorder; pinned and unpinned tabs stay in their own groups. */
  move(id: string, to: number) {
    const tabs = [...this.state.tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0 || from === to) return;
    const [t] = tabs.splice(from, 1);
    const pinnedCount = tabs.filter((x) => x.pinned).length;
    const at = t.pinned ? Math.min(to, pinnedCount) : Math.max(to, pinnedCount);
    tabs.splice(Math.min(at, tabs.length), 0, t);
    this.set({ ...this.state, tabs });
  }

  /** Unload the least recently used inactive tabs beyond MAX_LIVE. */
  private enforceCap() {
    const live = this.state.tabs.filter((t) => t.live && t.id !== this.state.active).sort((a, b) => a.used - b.used);
    const over = live.length + 1 - MAX_LIVE;
    if (over <= 0) return;
    const drop = new Set(live.slice(0, over).map((t) => t.id));
    this.state = { ...this.state, tabs: this.state.tabs.map((t) => (drop.has(t.id) ? { ...t, live: false, loading: false } : t)) };
    for (const l of this.listeners) l();
  }

  // ── Navigation and history

  navigate(id: string, url: string) {
    const t = this.tab(id);
    if (!t) return id;
    this.pending.set(id, url);
    const hist = [...t.hist.slice(0, t.idx + 1), url];
    this.go(t, url, { hist, idx: hist.length - 1 });
    return id;
  }
  back(id = this.state.active) {
    const t = this.tab(id);
    if (t && t.idx > 0) this.go(t, t.hist[t.idx - 1], { idx: t.idx - 1 }, true);
  }
  forward(id = this.state.active) {
    const t = this.tab(id);
    if (t && t.idx < t.hist.length - 1) this.go(t, t.hist[t.idx + 1], { idx: t.idx + 1 }, true);
  }
  private go(t: Tab, url: string, p: Partial<Tab>, hist = false) {
    if (hist) this.pending.set(t.id, url);
    const live = t.live && !t.blocked && this.driver?.replace(t.id, url);
    this.patch(t.id, live ? { ...p, url, loading: true, blocked: false } : { ...p, url, live: true, loading: true, blocked: false, src: url, gen: t.gen + 1, used: Date.now() });
    if (!t.live) this.enforceCap();
  }
  reload(id = this.state.active) {
    const t = this.tab(id);
    if (!t) return;
    if (t.live && !t.blocked && this.driver?.reload(id)) this.patch(id, { loading: true });
    else this.patch(id, { live: true, loading: true, blocked: false, src: t.url, gen: t.gen + 1 });
  }

  /**
   * What the tab's page reports: a client-side push or replace, a page load,
   * or a new title. A push adds a back entry; a load the tab asked for (or a
   * redirect from it) replaces the current one.
   */
  report(id: string, kind: "push" | "replace" | "load" | "title", url: string, title?: string) {
    const t = this.tab(id);
    if (!t) return;
    const p: Partial<Tab> = {};
    if (title !== undefined && title !== t.title) p.title = title;
    if (kind === "load") p.loading = false;
    if (kind !== "title" && url !== t.url) {
      p.url = url;
      const wanted = this.pending.get(id);
      if (wanted !== undefined || kind === "replace") {
        p.hist = t.hist.map((h, i) => (i === t.idx ? url : h));
      } else {
        p.hist = [...t.hist.slice(0, t.idx + 1), url];
        p.idx = p.hist.length - 1;
      }
    }
    if (kind === "load" || (kind !== "title" && this.pending.get(id) === url)) this.pending.delete(id);
    if (Object.keys(p).length) this.patch(id, p);
  }
  setLoading(id: string, loading: boolean) {
    if (this.tab(id)?.loading !== loading) this.patch(id, { loading });
  }
  setBlocked(id: string) {
    this.patch(id, { blocked: true, loading: false });
  }
}

/** One store per person and window. */
let store: TabStore | null = null;
export function tabStore(userKey: string, here: string) {
  if (!store) store = new TabStore(`iotx-tabs:${userKey}`, here);
  return store;
}

/** How often each app was opened (for the New Tab page's shortcuts). */
export const visitsKey = (userKey: string) => `iotx-visits:${userKey}`;
export function countVisit(userKey: string, url: string) {
  const id = tabApp(url).id;
  if (id === "newtab" || id === "page") return;
  try {
    const k = visitsKey(userKey);
    const v = JSON.parse(localStorage.getItem(k) || "{}") as Record<string, number>;
    v[id] = (v[id] ?? 0) + 1;
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}
