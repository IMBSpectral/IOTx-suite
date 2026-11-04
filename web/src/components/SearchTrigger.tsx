"use client";

import { Search } from "lucide-react";
import { SIDEBAR_ROW } from "./sidebar-styles";

/**
 * Opens the command palette. The palette owns the shortcut; this just
 * synthesizes the same keystroke so there is one code path for both.
 */
export default function SearchTrigger() {
  return (
    <button
      onClick={() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
        )
      }
      className={SIDEBAR_ROW}
    >
      <Search className="h-4 w-4 shrink-0" style={{ color: "var(--muted)" }} />
      <span className="flex-1 text-left">Search</span>
      <kbd className="rounded border px-1 text-[10px] leading-4" style={{ color: "var(--muted)" }}>
        Ctrl K
      </kbd>
    </button>
  );
}
