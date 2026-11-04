"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * One-time hint anchored above a control. Dismissal is remembered per
 * browser; "Reset hints" in Preferences brings them all back.
 */
const PREFIX = "forge:coach:";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const seen = (id: string) => () => {
  try {
    return localStorage.getItem(PREFIX + id) === "1";
  } catch {
    return true;
  }
};

export function dismissCoachmark(id: string) {
  try {
    localStorage.setItem(PREFIX + id, "1");
  } catch {}
  listeners.forEach((fn) => fn());
}

export function resetCoachmarks() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {}
  listeners.forEach((fn) => fn());
}

export default function Coachmark({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  // Hidden on the server and until hydrated, so it never flashes.
  const dismissed = useSyncExternalStore(subscribe, seen(id), () => true);
  if (dismissed) return null;
  return (
    <div
      role="status"
      className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl px-3 py-2.5 text-xs text-white shadow-xl"
      style={{ background: "#1c1917" }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{title}</p>
        <button onClick={() => dismissCoachmark(id)} aria-label="Dismiss hint" className="opacity-70 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1 leading-relaxed opacity-80">{children}</p>
      <button onClick={() => dismissCoachmark(id)} className="mt-2 font-medium underline-offset-2 hover:underline">
        Got it
      </button>
      <span className="absolute -bottom-1 left-6 h-2 w-2 rotate-45" style={{ background: "#1c1917" }} />
    </div>
  );
}
