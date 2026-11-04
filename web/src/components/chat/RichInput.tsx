"use client";

import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { Bold, Code, Italic, List, ListOrdered, SquareCode } from "lucide-react";
import { codeBlock, continueList, deleteMention, list, segments, wrap, type Edit } from "@/lib/composer-format";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValue: (v: string) => void;
  /** Names that count as mentions (files, connectors, projects, collections). */
  mentions: string[];
  commands: string[];
  /** When a suggestion menu is open, Enter/Tab belong to it, not to list continuation. */
  menuOpen?: boolean;
  maxRows?: number;
};

/**
 * The chat box: a textarea that stays the source of truth (plain Markdown),
 * with known @mentions and a leading /command drawn as chips on a layer
 * behind it, a formatting bar with shortcuts, list continuation and growth
 * with its content.
 */
const RichInput = forwardRef<HTMLTextAreaElement, Props>(function RichInput({ value, onValue, mentions, commands, menuOpen, maxRows = 10, onKeyDown, className, ...rest }, ref) {
  const box = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => box.current!);
  const known = useMemo(() => new Set(mentions), [mentions]);
  const cmds = useMemo(() => new Set(commands), [commands]);
  const parts = useMemo(() => segments(value, known, cmds), [value, known, cmds]);
  const hasChips = parts.some((p) => p.kind !== "text");

  // Grow with the text, up to maxRows, then scroll.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * maxRows + 8)}px`;
    if (layer.current) layer.current.scrollTop = el.scrollTop;
  }, [value, maxRows]);

  function apply(e: Edit) {
    onValue(e.text);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(e.start, e.end);
    });
  }
  const sel = () => [box.current?.selectionStart ?? value.length, box.current?.selectionEnd ?? value.length] as const;
  const format = {
    bold: () => apply(wrap(value, ...sel(), "**")),
    italic: () => apply(wrap(value, ...sel(), "_")),
    code: () => apply(wrap(value, ...sel(), "`")),
    block: () => apply(codeBlock(value, ...sel())),
    bullets: () => apply(list(value, ...sel(), "bullet")),
    numbers: () => apply(list(value, ...sel(), "number")),
  };

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const mod = e.ctrlKey || e.metaKey;
    const [s, end] = sel();
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const run = k === "b" ? format.bold : k === "i" ? format.italic : k === "e" && !e.shiftKey ? format.code : k === "e" ? format.block : k === "8" && e.shiftKey ? format.bullets : k === "7" && e.shiftKey ? format.numbers : null;
      if (run) {
        e.preventDefault();
        run();
        return;
      }
    }
    if (e.key === "Backspace" && s === end && !mod) {
      const d = deleteMention(value, s, known);
      if (d) {
        e.preventDefault();
        apply(d);
        return;
      }
    }
    // Shift+Enter in a list item continues the list (plain Enter still sends).
    if (e.key === "Enter" && e.shiftKey && !menuOpen && s === end) {
      const c = continueList(value, s);
      if (c) {
        e.preventDefault();
        apply(c);
        return;
      }
    }
    onKeyDown?.(e);
  }

  const tools = [
    ["Bold (Ctrl+B)", Bold, format.bold],
    ["Italic (Ctrl+I)", Italic, format.italic],
    ["Inline code (Ctrl+E)", Code, format.code],
    ["Code block (Ctrl+Shift+E)", SquareCode, format.block],
    ["Bulleted list (Ctrl+Shift+8)", List, format.bullets],
    ["Numbered list (Ctrl+Shift+7)", ListOrdered, format.numbers],
  ] as const;

  return (
    <div>
      <div className="relative">
        {/* The chip layer: same box, font and wrapping as the textarea, text invisible, chips visible. */}
        {hasChips && (
          <div
            ref={layer}
            aria-hidden
            className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent ${className ?? ""}`}
          >
            {parts.map((p, i) =>
              p.kind === "text" ? (
                <span key={i}>{p.text}</span>
              ) : (
                <span key={i} data-chip={p.kind} className="rounded" style={{ background: p.kind === "command" ? "var(--accent-soft)" : "color-mix(in srgb, var(--accent) 16%, transparent)", boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent)" }}>
                  {p.text}
                </span>
              ),
            )}
            {"​"}
          </div>
        )}
        <textarea
          ref={box}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          onKeyDown={keyDown}
          onScroll={(e) => {
            if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop;
          }}
          className={`relative ${className ?? ""}`}
          {...rest}
        />
      </div>
      <div role="toolbar" aria-label="Formatting" className="flex items-center gap-0.5 px-0.5 pt-0.5">
        {tools.map(([label, Icon, run]) => (
          <button
            key={label}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={run}
            aria-label={label.replace(/ \(.*\)$/, "")}
            title={label}
            className="rounded p-0.5 opacity-60 hover:bg-black/[.05] hover:opacity-100 dark:hover:bg-white/[.08]"
            style={{ color: "var(--muted)" }}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
});

export default RichInput;
