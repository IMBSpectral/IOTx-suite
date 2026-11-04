"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** Settings sections as underlined tabs; the current one is marked. */
export default function SettingsTabs({ nav }: { nav: { href: string; label: string }[] }) {
  const path = usePathname();
  const navRef = useRef<HTMLElement>(null);
  // The row scrolls sideways on narrow screens; keep the current tab in view.
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [path]);
  return (
    <nav ref={navRef} className="mb-7 flex gap-1 overflow-x-auto border-b [scrollbar-width:none]" aria-label="Settings sections">
      {nav.map((n) => {
        const active = n.href === "/settings" ? path === "/settings" : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors ${
              active ? "border-[var(--text)] font-medium" : "border-transparent hover:border-[var(--border)]"
            }`}
            style={active ? undefined : { color: "var(--muted)" }}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
