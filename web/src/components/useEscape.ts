"use client";

import { useEffect, useRef } from "react";

// Open dialogs, newest last: Escape closes only the one on top.
const stack: { current: (() => void) | null }[] = [];
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = stack.at(-1);
  if (!top) return;
  e.preventDefault();
  top.current?.();
}

/** Close a dialog with Escape. Pass null while it isn't open. */
export function useEscape(onEscape: (() => void) | null) {
  const ref = useRef(onEscape);
  useEffect(() => {
    ref.current = onEscape;
  });
  const open = onEscape !== null;
  useEffect(() => {
    if (!open) return;
    stack.push(ref);
    if (!listening) {
      window.addEventListener("keydown", onKey);
      listening = true;
    }
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}
