"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useBrand } from "@/components/BrandProvider";

/** Launch cards on the dashboard: what changed recently, each linking to its help article. */
const CARDS = [
  { id: "2026-10-grow", tag: "New", title: "Grow your audience with {brand}", body: "Set a target, get a tailored plan across search, ads and social, and draft Google Ads campaigns with ads written for you. Open a project's Grow tab.", href: "/help?q=grow" },
  { id: "2026-10-sharing", tag: "New", title: "Preview links and restricted projects", body: "Share the current version with a password and an expiry, or keep a project to invited people only.", href: "/help?q=share" },
  { id: "2026-10-limits", tag: "New", title: "Spending limits", body: "Cap monthly credits for the workspace, a member or a project, and see where credits went.", href: "/help?q=credits" },
  { id: "2026-10-security", tag: "Improved", title: "Security center", body: "Scan code and dependencies, fix findings for free, and block risky publishes.", href: "/help?q=security" },
  { id: "2026-10-import", tag: "New", title: "Import anything", body: "Start from a GitHub repository, a ZIP, or an existing website.", href: "/help?q=import" },
];

const KEY = "forge:whatsnew-dismissed";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return CARDS[0].id;
  }
};

export default function WhatsNew() {
  // Dismissing hides the carousel until a newer card ships.
  const dismissed = useSyncExternalStore(subscribe, read, () => CARDS[0].id);
  const [i, setI] = useState(0);
  const brand = useBrand();
  if (dismissed === CARDS[0].id) return null;
  const card = CARDS[i];

  return (
    <section aria-label="What's new" aria-roledescription="carousel" className="mt-8 rounded-2xl border p-4" style={{ background: "var(--panel)" }}>
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
          What&apos;s new
        </h2>
        <div className="flex items-center gap-1">
          <button onClick={() => setI((i + CARDS.length - 1) % CARDS.length)} aria-label="Previous" className="rounded-md p-1 hover:bg-black/[.05]">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-[11px] tabular-nums" style={{ color: "var(--muted)" }}>
            {i + 1}/{CARDS.length}
          </span>
          <button onClick={() => setI((i + 1) % CARDS.length)} aria-label="Next" className="rounded-md p-1 hover:bg-black/[.05]">
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              try {
                localStorage.setItem(KEY, CARDS[0].id);
              } catch {}
              listeners.forEach((fn) => fn());
            }}
            aria-label="Dismiss what's new"
            className="ml-1 rounded-md p-1 hover:bg-black/[.05]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <Link href={card.href} className="mt-2 block rounded-xl px-1 py-1 hover:bg-black/[.02]" aria-live="polite">
        <span className="rounded-full bg-[#6d4aff]/10 px-2 py-0.5 text-[10px] font-medium text-[#6d4aff]">{card.tag}</span>
        <p className="mt-1.5 text-sm font-medium">{card.title.replace("{brand}", brand.shortName)}</p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
          {card.body}
        </p>
      </Link>
    </section>
  );
}
