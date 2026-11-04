"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "light" | "dark" | "system";
const KEY = "forge-theme";
const EVENT = "forge-theme-change";
const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Light / Dark / System. Stored per browser; the layout script applies it
 * before paint. Read through an external store so the server render
 * ("system") and the saved choice reconcile cleanly after hydration.
 */
export default function ThemeToggle({ labels = false }: { labels?: boolean }) {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as Theme);

  function choose(t: Theme) {
    try {
      localStorage.setItem(KEY, t);
    } catch {}
    (window as unknown as { __forgeApplyTheme?: () => void }).__forgeApplyTheme?.();
    window.dispatchEvent(new Event(EVENT));
    // IOTx Suite keeps the theme on the account, so every device follows it.
    void fetch("/api/account/appearance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: t }) }).catch(() => undefined);
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg border p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
            theme === value ? "font-medium shadow-sm ring-1 ring-black/[.06] dark:ring-white/[.1]" : "hover:bg-black/[.04] dark:hover:bg-white/[.06]"
          }`}
          style={theme === value ? { background: "var(--panel)" } : { color: "var(--muted)" }}
        >
          <Icon className="h-3.5 w-3.5" />
          {labels && label}
        </button>
      ))}
    </div>
  );
}
