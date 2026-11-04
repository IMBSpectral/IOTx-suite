"use client";
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, EMOJI, noteEmoji, recentEmoji, searchEmoji } from "./emoji";

/** Full emoji picker: search by name, recent, and categories. */
export default function EmojiPicker({ onPick, onClose, align = "right" }: { onPick: (e: string) => void; onClose: () => void; align?: "left" | "right" | "up" }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("Recent");
  const box = useRef<HTMLDivElement>(null);
  const recent = recentEmoji();
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    const t = setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const pick = (e: string) => {
    noteEmoji(e);
    onPick(e);
  };
  const list = q ? searchEmoji(q, 120) : cat === "Recent" ? recent.map((e) => EMOJI.find((x) => x.e === e) ?? { e, n: "", c: "" }) : EMOJI.filter((x) => x.c === cat);
  return (
    <div ref={box} className={`ch-emoji-pop ${align}`} role="dialog" aria-label="Emoji picker" onMouseDown={(e) => e.stopPropagation()}>
      <input className="ws-input" autoFocus placeholder="Search emoji" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search emoji"
        onKeyDown={(e) => { if (e.key === "Enter" && list[0]) { e.preventDefault(); pick(list[0].e); } }} />
      {!q && (
        <div className="ch-emoji-tabs" role="tablist">
          {["Recent", ...CATEGORIES].map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cat === c} className={cat === c ? "on" : ""} onClick={() => setCat(c)} title={c}>
              {c === "Recent" ? "🕘" : EMOJI.find((x) => x.c === c)!.e}
            </button>
          ))}
        </div>
      )}
      <div className="ch-emoji-grid">
        {list.length === 0 && <span className="ws-muted" style={{ gridColumn: "1 / -1", padding: 8 }}>{cat === "Recent" && !q ? "Emoji you use show up here." : "No emoji match."}</span>}
        {list.map((x) => (
          <button key={x.e + x.n} type="button" onClick={() => pick(x.e)} title={x.n ? `:${x.n}:` : x.e} aria-label={x.n || x.e}>{x.e}</button>
        ))}
      </div>
    </div>
  );
}
