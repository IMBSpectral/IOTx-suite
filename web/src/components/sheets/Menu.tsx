"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";

export type Item =
  | "-"
  | {
      label: string;
      icon?: React.ReactNode;
      hint?: string;
      onClick?: () => void;
      disabled?: boolean;
      checked?: boolean;
      sub?: Item[];
      danger?: boolean;
    };

/** Closes when someone clicks outside it or presses Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", esc);
    };
  }, [open, close]);
  return ref;
}

/** A Google-style dropdown list with checkmarks, shortcuts and submenus. */
export function MenuList({ items, onDone, style, label }: { items: Item[]; onDone: () => void; style?: React.CSSProperties; label?: string }) {
  const [sub, setSub] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Keep it on screen: flip left or up when it would overflow.
  const [shift, setShift] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.right > window.innerWidth - 4 ? window.innerWidth - 4 - r.right : 0;
    const y = r.bottom > window.innerHeight - 4 ? Math.max(-r.top + 4, window.innerHeight - 4 - r.bottom) : 0;
    if (x || y) requestAnimationFrame(() => setShift({ x, y }));
  }, []);
  return (
    <div ref={ref} role="menu" aria-label={label} className={`sx-menu ${items.some((it) => it !== "-" && it.sub) ? "" : "scroll"}`} style={{ ...style, transform: `translate(${shift.x}px, ${shift.y}px)` }}>
      {items.map((it, i) =>
        it === "-" ? (
          <div key={i} className="sx-sep" role="separator" />
        ) : (
          <div key={i} style={{ position: "relative" }} onMouseEnter={() => setSub(it.sub ? i : null)}>
            <button
              type="button"
              role="menuitem"
              className={`sx-mi ${it.danger ? "danger" : ""}`}
              disabled={it.disabled}
              aria-haspopup={it.sub ? "menu" : undefined}
              aria-expanded={it.sub ? sub === i : undefined}
              onClick={() => {
                if (it.sub) return setSub(sub === i ? null : i);
                it.onClick?.();
                onDone();
              }}
            >
              <span className="sx-mi-ico">{it.checked ? <Check size={15} /> : it.icon}</span>
              <span className="sx-mi-label">{it.label}</span>
              {it.hint && <span className="sx-mi-hint">{it.hint}</span>}
              {it.sub && <ChevronRight size={15} className="sx-mi-hint" />}
            </button>
            {it.sub && sub === i && <MenuList items={it.sub} onDone={onDone} style={{ position: "absolute", left: "100%", top: -6 }} label={it.label} />}
          </div>
        ),
      )}
    </div>
  );
}

/** A button that opens a dropdown below it. */
export function Dropdown({
  button,
  items,
  title,
  className,
  disabled,
  children,
  align = "left",
}: {
  button: React.ReactNode;
  items?: Item[];
  title: string;
  className?: string;
  disabled?: boolean;
  children?: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<React.CSSProperties>({});
  const ref = useDismiss(open, () => setOpen(false));
  // Placed on the page, not inside the bar: the toolbar and tab strip scroll sideways and would clip it.
  function toggle() {
    const r = ref.current?.getBoundingClientRect();
    if (r && !open) {
      const up = r.bottom + 320 > window.innerHeight && r.top > window.innerHeight / 2;
      setPlace({
        position: "fixed",
        ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        ...(align === "right" ? { right: Math.max(4, window.innerWidth - r.right) } : { left: Math.max(4, r.left) }),
      });
    }
    setOpen((o) => !o);
  }
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" className={className ?? "sx-tb"} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
        {button}
      </button>
      {open &&
        (children ? (
          <div className="sx-pop" style={place}>
            {children(() => setOpen(false))}
          </div>
        ) : (
          <MenuList items={items ?? []} onDone={() => setOpen(false)} label={title} style={place} />
        ))}
    </div>
  );
}
