"use client";

/** Browser helpers: API calls under the /workspace base path and the one SSE stream. */
export const BASE = "/workspace";

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401 && typeof window !== "undefined") {
    window.location.reload();
  }
  if (!r.ok) throw new ApiError(r.status, String(d.error ?? `Request failed (${r.status})`), d);
  return d as T;
}

type Listener = (type: string, data: any) => void;
let es: EventSource | null = null;
const listeners = new Set<Listener>();
const TYPES = ["notification", "message", "message.update", "message.delete", "reaction", "channel", "read", "typing", "task", "presence", "ephemeral", "apps"];

export function subscribe(fn: Listener) {
  listeners.add(fn);
  if (!es && typeof window !== "undefined") {
    es = new EventSource(`${BASE}/api/stream`);
    for (const t of TYPES)
      es.addEventListener(t, (e) => {
        let d: unknown = null;
        try {
          d = JSON.parse((e as MessageEvent).data);
        } catch {}
        for (const l of listeners) l(t, d);
      });
  }
  return () => {
    listeners.delete(fn);
  };
}

export function initials(name: string) {
  return name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

const PALETTE = ["#4f46e5", "#0891b2", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#0d9488"];
export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Running in a suite tab whose frame has the global @ picker: its @ menus step aside for it. */
export function suiteAt() {
  try {
    return typeof window !== "undefined" && window.top !== window.self && !!(window.top as unknown as { __iotxMentions?: boolean }).__iotxMentions;
  } catch {
    return false;
  }
}
