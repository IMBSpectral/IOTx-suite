"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Tips shown while the agent works, each with a one-click follow-up that is
 * queued behind the current turn. Can be turned off; the choice is remembered
 * in this browser.
 */
const TIPS: { text: string; prompt: string; mobile?: string }[] = [
  { text: "Plan mode drafts a plan you approve before anything is built.", prompt: "/plan" },
  { text: "Attach a screenshot or a PDF and the agent can work from it.", prompt: "" },
  { text: "Type @ to point the agent at a specific file.", prompt: "" },
  { text: "Ask for an SEO pass so people can find your site.", prompt: "Review the site's SEO: page titles, meta descriptions, Open Graph tags, headings and alt text. Fix what's missing." },
  { text: "Make it feel finished: empty states, loading states and errors.", prompt: "Add proper empty, loading and error states everywhere the app shows data." },
  { text: "Check it on a phone — most visitors arrive on mobile.", prompt: "Review the layout at 375px wide and fix anything cramped, overflowing or hard to tap." },
  { text: "Ask for an accessibility pass.", prompt: "Do an accessibility pass: contrast, focus states, labels, alt text and keyboard navigation." },
  { text: "Generated images replace placeholders — ask for a hero image.", prompt: "Replace any placeholder imagery with generated images that match the design." },
  { text: "Connect Stripe, email and other services from + in the chat box, then Connectors.", mobile: "Tap your project name, then Connectors, to link Stripe, email and other services.", prompt: "" },
  { text: "Ask mode answers questions without changing your app, and is free up to a daily allowance.", prompt: "" },
  { text: "Draw on an image you attach to show exactly what to change.", mobile: "Attach a screenshot and mark it up to show exactly what to change.", prompt: "" },
  { text: "Select an element in the preview, then describe the change.", mobile: "Switch to Preview, tap Select, then tap the element to change.", prompt: "" },
  { text: "Keep API keys in Secrets, never in the code.", prompt: "" },
  { text: "Run a security scan before you publish.", prompt: "Run a security review of the app and fix anything critical or high." },
  { text: "Skills turn prompts you reuse into / commands.", prompt: "" },
  { text: "Organise projects into folders from the Projects page.", prompt: "" },
  { text: "Add payments: ask for a checkout with Stripe.", prompt: "Add a Stripe checkout for the main product, with success and cancel pages." },
];

// Touch screens get their own wording ("tap", not "click").
const coarse = (fn: () => void) => {
  const mq = window.matchMedia("(pointer: coarse)");
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
};
const isCoarse = () => window.matchMedia("(pointer: coarse)").matches;

const KEY = "forge:tips";

// The preference lives in localStorage; reading it through an external store
// keeps server and client renders consistent (hidden until hydrated).
const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function readHidden() {
  try {
    return localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
}

export function setTipsHidden(value: boolean) {
  try {
    localStorage.setItem(KEY, value ? "off" : "on");
  } catch {}
  listeners.forEach((fn) => fn());
}

/** Whether tips are hidden, for the Tips & tricks setting. */
export function useTipsHidden() {
  return useSyncExternalStore(subscribe, readHidden, () => false);
}

export default function Tips({ onTry }: { onTry: (prompt: string) => void }) {
  const hidden = useSyncExternalStore(subscribe, readHidden, () => true);
  const touch = useSyncExternalStore(coarse, isCoarse, () => false);
  const [i, setI] = useState(() => Math.floor(Math.random() * TIPS.length));
  const setHidden = setTipsHidden;

  useEffect(() => {
    if (hidden) return;
    const t = setInterval(() => setI((n) => (n + 1) % TIPS.length), 9000);
    return () => clearInterval(t);
  }, [hidden]);

  if (hidden) return null;
  const tip = TIPS[i];
  return (
    <div className="mt-3 rounded-xl border px-3 py-2 text-[12px]" style={{ background: "var(--panel)" }}>
      <div className="flex items-start justify-between gap-2">
        <p>
          <span className="font-medium">Tip · </span>
          {(touch && tip.mobile) || tip.text}
        </p>
        <button
          onClick={() => setHidden(true)}
          title="Turn them back on in Settings under Tips & tricks"
          className="shrink-0 text-[11px] hover:underline"
          style={{ color: "var(--muted)" }}
        >
          Hide tips
        </button>
      </div>
      {tip.prompt && !tip.prompt.startsWith("/") && (
        <button onClick={() => onTry(tip.prompt)} className="mt-1 text-[11px] font-medium text-[#6d4aff] hover:underline">
          Queue this →
        </button>
      )}
    </div>
  );
}
