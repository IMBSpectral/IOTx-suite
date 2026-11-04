"use client";

import { useSyncExternalStore } from "react";

/** The app's theme (html[data-theme], set by the layout script), followed live. */
function subscribeTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}
const readDark = () => document.documentElement.dataset.theme === "dark";

export function useDarkTheme() {
  return useSyncExternalStore(subscribeTheme, readDark, () => false);
}

const MOTION = "(prefers-reduced-motion: reduce)";
function subscribeMotion(onChange: () => void) {
  const m = window.matchMedia(MOTION);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia(MOTION).matches, () => false);
}
