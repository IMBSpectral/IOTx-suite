"use client";

import { useEffect, useState } from "react";

type Prefs = { suggestions: "all" | "first" | "off"; sandboxDiagnostics: boolean };

// One request per page load, shared by every message.
let cached: Promise<Prefs | null> | null = null;

/** The signed-in person's account preferences (Settings → Preferences). */
export function useAccountPrefs() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    cached ??= fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d?.prefs as Prefs) ?? null)
      .catch(() => null);
    let live = true;
    void cached.then((p) => live && setPrefs(p));
    return () => {
      live = false;
    };
  }, []);
  return prefs;
}
