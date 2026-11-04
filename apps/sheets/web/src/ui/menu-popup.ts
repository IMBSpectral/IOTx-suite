// A Google Sheets-style popup menu: keyboard navigable (arrows, Home/End, Enter/Space, letters),
// submenus on hover or ArrowRight, check marks, shortcut hints on the right, separators and
// disabled items. Used by the menu bar, the right-click menus and the sheet-tab menu.

export interface MenuItem {
  label: string;
  /** Runs after the whole menu has closed (so focus is back on the grid unless `run` moves it). */
  run?: () => unknown;
  shortcut?: string;
  /** Gray text on the right when there is no shortcut (e.g. a number format sample). */
  hint?: string;
  disabled?: boolean;
  /** Present (true/false) for check items: renders a check mark and role menuitemcheckbox. */
  checked?: boolean;
  submenu?: () => MenuEntry[];
  /** Becomes `data-testid="menu-<id>"`. */
  id?: string;
  /** Small leading glyph in the icon column. */
  icon?: string;
}

/** A free-form block inside a menu (the tab colour palette). Focusable children with
 * `data-menu-item` join the arrow-key order; `close` closes the whole menu tree. */
export interface MenuCustom {
  custom: (close: () => void) => HTMLElement;
}

export type MenuEntry = MenuItem | MenuCustom | "-";

export type Placement = { x: number; y: number } | { anchor: HTMLElement; side: "below" | "right" };

export interface MenuOptions {
  /** Called once when the whole tree closes. `reason` "select" means an item ran. */
  onClose?: (reason: "select" | "escape" | "outside" | "tab" | "replaced") => void;
  /** ArrowLeft/ArrowRight on a top-level menu (menu bar navigation). */
  onNavigate?: (dir: -1 | 1) => void;
  /** Clicks on these elements don't count as "outside" (the menu bar itself). */
  keepOpenOn?: HTMLElement[];
  label?: string;
  /** Focus the first item at once (keyboard open). Default true. */
  focusFirst?: boolean;
  testid?: string;
}

const isItem = (e: MenuEntry): e is MenuItem => typeof e === "object" && "label" in e;

let root: PopupMenu | null = null;

/** Opens a menu (closing any other open menu tree). */
export function openMenu(entries: MenuEntry[], at: Placement, opts: MenuOptions = {}): PopupMenu {
  root?.closeAll("replaced");
  root = new PopupMenu(entries, at, opts, null);
  return root;
}

export function closeMenus(): void {
  root?.closeAll("escape");
}

export function menuOpen(): boolean {
  return root !== null;
}

export class PopupMenu {
  readonly el: HTMLDivElement;
  private child: PopupMenu | null = null;
  private childOwner: HTMLElement | null = null;
  private hoverTimer = 0;
  private closed = false;
  private readonly onDocDown = (e: PointerEvent) => this.outside(e);

  constructor(
    entries: MenuEntry[],
    at: Placement,
    private opts: MenuOptions,
    private parent: PopupMenu | null,
  ) {
    const el = document.createElement("div");
    el.className = "menu-popup";
    el.setAttribute("role", "menu");
    el.tabIndex = -1;
    if (opts.label) el.setAttribute("aria-label", opts.label);
    if (opts.testid) el.dataset.testid = opts.testid;
    this.el = el;
    for (const entry of entries) el.append(this.render(entry));
    el.addEventListener("keydown", (e) => this.onKey(e));
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("mousedown", (e) => {
      // Keep focus on the item (and the grid's editor untouched) when clicking inside.
      if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
    });
    document.body.append(el);
    this.place(at);
    if (!parent) document.addEventListener("pointerdown", this.onDocDown, true);
    if (opts.focusFirst !== false) this.focusIndex(0);
    else el.focus({ preventScroll: true });
  }

  private render(entry: MenuEntry): HTMLElement {
    if (entry === "-") {
      const s = document.createElement("div");
      s.className = "menu-sep";
      s.setAttribute("role", "separator");
      return s;
    }
    if (!isItem(entry)) {
      const box = entry.custom(() => this.top().closeAll("select"));
      box.classList.add("menu-custom");
      return box;
    }
    const it = document.createElement("div");
    it.className = "menu-item";
    it.tabIndex = -1;
    it.dataset.menuItem = "";
    it.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (entry.checked !== undefined) it.setAttribute("aria-checked", String(entry.checked));
    it.setAttribute("aria-label", entry.label);
    if (entry.id) it.dataset.testid = `menu-${entry.id}`;
    if (entry.disabled) it.setAttribute("aria-disabled", "true");
    if (entry.shortcut) it.setAttribute("aria-keyshortcuts", entry.shortcut.replace(/\s/g, ""));
    const icon = document.createElement("span");
    icon.className = "menu-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = entry.checked ? "✓" : (entry.icon ?? "");
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = entry.label;
    const right = document.createElement("span");
    right.className = "menu-right";
    right.setAttribute("aria-hidden", "true");
    right.textContent = entry.submenu ? "" : (entry.shortcut ?? entry.hint ?? "");
    it.append(icon, label, right);
    if (entry.submenu) {
      it.setAttribute("aria-haspopup", "menu");
      it.setAttribute("aria-expanded", "false");
      const arrow = document.createElement("span");
      arrow.className = "menu-arrow";
      arrow.setAttribute("aria-hidden", "true");
      it.append(arrow);
    }
    it.addEventListener("mouseenter", () => {
      it.focus({ preventScroll: true });
      clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => {
        if (this.closed) return;
        if (entry.submenu && !entry.disabled) {
          if (this.childOwner !== it) this.openChild(it, entry, false);
        } else this.closeChild();
      }, 120);
    });
    it.addEventListener("click", (e) => {
      e.stopPropagation();
      this.activate(it, entry, false);
    });
    (it as HTMLElement & { _entry?: MenuItem })._entry = entry;
    return it;
  }

  private activate(it: HTMLElement, entry: MenuItem, keyboard: boolean): void {
    if (entry.disabled) return;
    if (entry.submenu) {
      clearTimeout(this.hoverTimer);
      if (this.childOwner !== it) this.openChild(it, entry, keyboard);
      else if (keyboard) this.child?.focusIndex(0);
      return;
    }
    this.top().closeAll("select");
    void Promise.resolve()
      .then(() => entry.run?.())
      .catch((e) => console.error(e));
  }

  private openChild(it: HTMLElement, entry: MenuItem, keyboard: boolean): void {
    this.closeChild();
    if (!entry.submenu) return;
    this.child = new PopupMenu(entry.submenu(), { anchor: it, side: "right" }, { focusFirst: keyboard, label: entry.label }, this);
    this.childOwner = it;
    it.setAttribute("aria-expanded", "true");
    it.classList.add("open");
  }

  private closeChild(): void {
    if (!this.child) return;
    this.child.destroy();
    this.childOwner?.setAttribute("aria-expanded", "false");
    this.childOwner?.classList.remove("open");
    this.child = null;
    this.childOwner = null;
  }

  private top(): PopupMenu {
    let m: PopupMenu = this;
    while (m.parent) m = m.parent;
    return m;
  }

  private destroy(): void {
    this.closeChild();
    clearTimeout(this.hoverTimer);
    this.closed = true;
    this.el.remove();
  }

  /** Closes this menu tree (call on the root). */
  closeAll(reason: Parameters<NonNullable<MenuOptions["onClose"]>>[0]): void {
    const t = this.top();
    if (t.closed) return;
    t.destroy();
    document.removeEventListener("pointerdown", t.onDocDown, true);
    if (root === t) root = null;
    t.opts.onClose?.(reason);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private outside(e: PointerEvent): void {
    const target = e.target as Node;
    for (let m: PopupMenu | null = this; m; m = m.child) if (m.el.contains(target)) return;
    if (this.opts.keepOpenOn?.some((k) => k.contains(target))) return;
    this.closeAll("outside");
  }

  private items(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>("[data-menu-item]")];
  }

  focusIndex(i: number): void {
    const items = this.items();
    if (!items.length) return this.el.focus({ preventScroll: true });
    const enabled = items.filter((x) => x.getAttribute("aria-disabled") !== "true");
    (enabled[i < 0 ? enabled.length - 1 : Math.min(i, enabled.length - 1)] ?? items[0]).focus({ preventScroll: true });
  }

  private step(dir: 1 | -1): void {
    const items = this.items().filter((x) => x.getAttribute("aria-disabled") !== "true");
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (dir > 0 ? 0 : items.length - 1) : (at + dir + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  private onKey(e: KeyboardEvent): void {
    // Keys typed into an input inside the menu (none today) stay there.
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    e.stopPropagation();
    const cur = document.activeElement as (HTMLElement & { _entry?: MenuItem }) | null;
    // Only the deepest menu that holds focus handles keys.
    if (cur && !this.el.contains(cur)) return;
    const entry = cur?._entry;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.step(-1);
        break;
      case "Home":
        e.preventDefault();
        this.focusIndex(0);
        break;
      case "End":
        e.preventDefault();
        this.focusIndex(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur && entry) this.activate(cur, entry, true);
        else cur?.click();
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur && entry?.submenu && !entry.disabled) this.activate(cur, entry, true);
        else this.top().opts.onNavigate?.(1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (this.parent) {
          const owner = this.parent.childOwner;
          this.parent.closeChild();
          owner?.focus({ preventScroll: true });
        } else this.opts.onNavigate?.(-1);
        break;
      case "Escape":
        e.preventDefault();
        if (this.parent) {
          const owner = this.parent.childOwner;
          this.parent.closeChild();
          owner?.focus({ preventScroll: true });
        } else this.closeAll("escape");
        break;
      case "Tab":
        e.preventDefault();
        this.closeAll("tab");
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const k = e.key.toLowerCase();
          const items = this.items().filter((x) => x.getAttribute("aria-disabled") !== "true");
          const at = items.indexOf(cur as HTMLElement);
          const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
          const hit = order.find((x) => (x.getAttribute("aria-label") ?? "").toLowerCase().startsWith(k));
          if (hit) {
            e.preventDefault();
            hit.focus({ preventScroll: true });
          }
        }
    }
  }

  private place(at: Placement): void {
    const el = this.el;
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x: number;
    let y: number;
    if ("anchor" in at) {
      const r = at.anchor.getBoundingClientRect();
      if (at.side === "below") {
        x = r.left;
        y = r.bottom + 2;
        if (y + h > vh - 4 && r.top - h - 2 > 4) y = r.top - h - 2;
      } else {
        x = r.right - 2;
        y = r.top - 8;
        if (x + w > vw - 4) x = Math.max(4, r.left - w + 2);
      }
    } else {
      x = at.x;
      y = at.y;
      if (x + w > vw - 4) x = Math.max(4, x - w);
      if (y + h > vh - 4) y = Math.max(4, vh - h - 4);
    }
    el.style.left = `${Math.max(4, Math.min(x, vw - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, vh - h - 4))}px`;
    el.style.maxHeight = `${vh - 8}px`;
  }
}
