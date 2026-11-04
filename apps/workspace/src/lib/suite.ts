import { SUITE_PUBLIC_URL, SUITE_URL } from "./env";
import type { Appearance } from "./suite-appearance";

/**
 * The suite shell, server to server. Calendar, Tasks and Chat render inside
 * the IOTx Suite's own sidebar and top bar (components/suite, copies of
 * web/src/components/iotx), fed by the suite's GET /api/iotx/shell. Calls are
 * authorised with IOTX_SERVICE_KEY; the browser never talks to these routes.
 */

export type SuiteApp = { id: string; name: string; desc: string; color: string; icon: string; status: "live" | "soon"; href: string };
export type SuitePerms = {
  keys: string[];
  apps: string[];
  limits: Record<string, number | null>;
  isOwner: boolean;
  plan: string;
  roles: { id: string; name: string; builtin: string | null }[];
  preview: { roleId: string; name: string } | null;
  canManage: boolean;
};
export type SuiteBrand = { name: string; shortName: string; mark: string; logo: string | null; tagline: string; company: string; supportEmail: string; colorFrom: string; colorTo: string };
export type SuiteShell = {
  shell: {
    perms: SuitePerms | null;
    appearance: Appearance;
    user: { name: string | null; email: string; image: string | null };
    workspace: { id: string; name: string; plan: string };
    workspaces: { id: string; name: string; plan: string; role: string }[];
    recentChats: { id: string; title: string }[];
  };
  paint: { theme: string; palettes: Record<string, Record<string, string>> };
  brand: SuiteBrand;
  apps: SuiteApp[];
  sidebar: string[];
  /** Where suite pages live for the browser ("" in production: same origin). */
  suite: string;
  /** True when the suite couldn't be reached and this is a stand-in. */
  offline?: boolean;
};

const KEY = () => process.env.IOTX_SERVICE_KEY ?? "";
const abs = (u: string | null) => (u && u.startsWith("/") && !u.startsWith("//") ? `${SUITE_PUBLIC_URL}${u}` : u);

const cache = new Map<string, { at: number; data: SuiteShell }>();
const TTL = 10_000;

/** Forget a cached shell (after the person changes their appearance here). */
export const dropShell = (userId: string) => {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
};

export async function suiteShell(userId: string, ws: string, me: { name: string; email: string }): Promise<SuiteShell> {
  const k = `${userId}:${ws}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  try {
    const r = await fetch(`${SUITE_URL}/api/iotx/shell?userId=${encodeURIComponent(userId)}&ws=${encodeURIComponent(ws)}`, {
      headers: { "x-iotx-key": KEY() },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`shell ${r.status}`);
    const d = (await r.json()) as Omit<SuiteShell, "suite">;
    const data: SuiteShell = { ...d, suite: SUITE_PUBLIC_URL };
    data.brand = { ...data.brand, logo: abs(data.brand.logo) };
    data.shell.user.image = abs(data.shell.user.image);
    const bg = data.shell.appearance.shellBg;
    if (bg?.kind === "image" && bg.image) data.shell.appearance = { ...data.shell.appearance, shellBg: { ...bg, image: abs(bg.image) ?? undefined } };
    cache.set(k, { at: Date.now(), data });
    return data;
  } catch {
    return fallback(me);
  }
}

/** For people without a suite account (Chat guests): the stand-in, never a call to the suite. */
export const standinShell = (me: { name: string; email: string }) => fallback(me);

/** If the suite is down: the same frame with only these three apps, so the page still works. */
function fallback(me: { name: string; email: string }): SuiteShell {
  const apps: SuiteApp[] = [
    { id: "teamchat", name: "Chat", desc: "Channels & messages", color: "linear-gradient(135deg,#0891b2,#22d3ee)", icon: "chat", status: "live", href: "/workspace/chat" },
    { id: "tasks", name: "Tasks", desc: "Projects & boards", color: "linear-gradient(135deg,#16a34a,#4ade80)", icon: "tasks", status: "live", href: "/workspace/tasks" },
    { id: "calendar", name: "Calendar", desc: "Your schedule", color: "linear-gradient(135deg,#4338ca,#818cf8)", icon: "calendar", status: "live", href: "/workspace/calendar" },
  ];
  return {
    shell: {
      perms: null,
      appearance: { theme: "system", accent: "indigo", accentCustom: null, shellBg: { kind: "none" } },
      user: { name: me.name, email: me.email, image: null },
      workspace: { id: "", name: "", plan: "FREE" },
      workspaces: [],
      recentChats: [],
    },
    paint: { theme: "system", palettes: {} },
    brand: { name: "IOTx Suite", shortName: "IOTx", mark: "IX", logo: null, tagline: "", company: "IOTx", supportEmail: "", colorFrom: "#6d5dfc", colorTo: "#a855f7" },
    apps,
    sidebar: ["teamchat", "calendar", "tasks"],
    suite: SUITE_PUBLIC_URL,
    offline: true,
  };
}

/** Server to server call to the suite with the service key. */
export async function suiteCall<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
  const r = await fetch(`${SUITE_URL}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "x-iotx-key": KEY(), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as T };
}
