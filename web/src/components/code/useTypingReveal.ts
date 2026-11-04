"use client";

import { useEffect, useState } from "react";

/**
 * Reveal `target` a few characters at a time, as if typed, catching up within
 * about two seconds however much arrives at once. Text that no longer extends
 * what's shown (another file) starts over. Off (the whole text at once) when
 * `animate` is false, e.g. for prefers-reduced-motion.
 */
export function useTypingReveal(target: string, animate: boolean) {
  const [shown, setShown] = useState("");
  useEffect(() => {
    if (!animate) return;
    const t = setInterval(() => {
      setShown((s) => {
        const base = target.startsWith(s) ? s : "";
        if (base.length >= target.length) return base;
        const step = Math.max(6, Math.ceil((target.length - base.length) / 50));
        return target.slice(0, base.length + step);
      });
    }, 40);
    return () => clearInterval(t);
  }, [target, animate]);
  if (!animate) return target;
  return target.startsWith(shown) ? shown : "";
}
