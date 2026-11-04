"use client";

import { paintPayload, type Appearance } from "@/lib/iotx/appearance";

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
  const res = await fetch("/api/account/appearance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => null);
  if (!res?.ok) return null;
  const d = (await res.json()) as { appearance: Appearance };
  applyLocally(d.appearance);
  return d.appearance;
}

/** Upload a background image; resolves to its url or an error message. */
export async function uploadBackground(file: File): Promise<{ url?: string; error?: string }> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/account/appearance", { method: "POST", body: form }).catch(() => null);
  const d = (await res?.json().catch(() => ({}))) as { url?: string; error?: string };
  return res?.ok ? { url: d.url } : { error: d?.error ?? "Couldn't upload the image." };
}

/** Start a build from a prompt: a new project, then the editor runs the first turn (Build or Plan). */
export async function startBuild(prompt: string, mode: "build" | "plan", push: (href: string) => void): Promise<string | null> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: prompt.slice(0, 60), force: true }),
  }).catch(() => null);
  const d = (await res?.json().catch(() => ({}))) as { project?: { id: string }; error?: string };
  if (!res?.ok || !d.project) return d?.error ?? "Couldn't start the build.";
  try {
    sessionStorage.setItem(`seed:${d.project.id}`, prompt);
    if (mode === "plan") sessionStorage.setItem(`seedMode:${d.project.id}`, "plan");
  } catch {}
  push(`/projects/${d.project.id}`);
  return null;
}
