"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone, X } from "lucide-react";

type Announcement = { id: string; title: string; body: string; href?: string; endsAt?: string; countdown?: boolean; scope?: "workspace" };

function left(endsAt: string) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "ended";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m left`;
}
const KEY = "forge-dismissed-announcements";

function dismissedIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** The newest current announcement you haven't dismissed, above the dashboard. */
export default function AnnouncementBanner() {
  const [item, setItem] = useState<Announcement | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/announcements")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { announcements: Announcement[] } | null) => {
        if (!live || !d) return;
        const gone = dismissedIds();
        setItem(d.announcements.find((a) => !gone.includes(a.id)) ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!item) return null;
  return (
    <div role="status" className="relative z-10 mx-auto mb-6 flex max-w-[672px] items-start gap-2 rounded-xl border px-3 py-2 text-xs" style={{ background: "var(--panel)" }}>
      <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} />
      <div className="min-w-0 flex-1">
        {item.scope === "workspace" && <span className="mr-1 rounded border px-1 text-[10px]">Workspace</span>}
        <span className="font-medium">{item.title}</span> <span style={{ color: "var(--muted)" }}>{item.body}</span>
        {item.countdown && item.endsAt && <span className="ml-1 font-medium tabular-nums">· {left(item.endsAt)}</span>}
        {item.href && (
          <Link href={item.href} className="ml-1 font-medium underline">
            Learn more
          </Link>
        )}
      </div>
      <button
        onClick={() => {
          try {
            localStorage.setItem(KEY, JSON.stringify([...dismissedIds(), item.id].slice(-50)));
          } catch {}
          setItem(null);
        }}
        aria-label="Dismiss announcement"
        className="rounded p-0.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
