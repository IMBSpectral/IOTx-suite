"use client";

import { useState } from "react";

const EMOJI = [
  "🚀", "✨", "🎨", "🛍️", "📊", "🧠", "🌿", "🔥", "💡", "🎯", "📱", "🏠",
  "🍕", "☕", "🎵", "📚", "💼", "🏋️", "🌍", "🐶", "🎮", "💬", "🔒", "⚡",
];

/** "Change icon" for a project: shown in the chat header and dashboard cards. */
export default function EmojiPicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string | null;
  onChange: (emoji: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  async function choose(emoji: string | null) {
    setOpen(false);
    onChange(emoji);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
    }).catch(() => undefined);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Change icon"
        title="Change icon"
        aria-expanded={open}
        className="grid h-7 w-7 place-items-center rounded-lg text-base hover:bg-black/[.05] dark:hover:bg-white/[.08]"
      >
        {value ?? <span className="text-xs" style={{ color: "var(--muted)" }}>☺</span>}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 grid w-56 grid-cols-6 gap-1 rounded-xl border p-2 shadow-lg"
          style={{ background: "var(--panel)" }}
          onMouseLeave={() => setOpen(false)}
        >
          {EMOJI.map((e) => (
            <button key={e} role="menuitem" onClick={() => choose(e)} className="rounded-md p-1 text-lg hover:bg-black/[.05]">
              {e}
            </button>
          ))}
          {value && (
            <button role="menuitem" onClick={() => choose(null)} className="col-span-6 mt-1 rounded-md py-1 text-[11px] hover:bg-black/[.05]" style={{ color: "var(--muted)" }}>
              Remove icon
            </button>
          )}
        </div>
      )}
    </div>
  );
}
