// COPY of web/src/components/iotx/appearance-client.ts: applyLocally is verbatim; saving goes
// through this app's /workspace/api/suite/appearance (server to server to the suite).
// Keep in step with web; see docs/WORKSPACE-STATUS.md.
"use client";

import { paintPayload, type Appearance } from "@/lib/suite-appearance";

/**
 * Apply an appearance in this browser now (theme + accent palette through
 * the root layout's paint script) and remember it for the next first paint.
 */
export function applyLocally(a: Appearance) {
  try {
    localStorage.setItem("forge-theme", a.theme);
    localStorage.setItem("iotx-paint", JSON.stringify(paintPayload(a)));
  } catch {}
  (window as unknown as { __forgeApplyTheme?: () => void }).__forgeApplyTheme?.();
  window.dispatchEvent(new Event("forge-theme-change"));
  window.dispatchEvent(new CustomEvent("iotx:appearance", { detail: a }));
}

/** Save to the account (every device) and apply here. Resolves to the saved value. */
export async function saveAppearance(patch: Partial<Appearance>): Promise<Appearance | null> {
  const res = await fetch("/workspace/api/suite/appearance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => null);
  if (!res?.ok) return null;
  const d = (await res.json()) as { appearance: Appearance };
  applyLocally(d.appearance);
  return d.appearance;
}
