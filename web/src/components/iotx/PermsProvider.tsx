"use client";

import { createContext, useContext, useMemo } from "react";

/**
 * What the signed-in person can do, for the screen. The server hides and
 * refuses the same things (lib/iotx/permissions.ts); this only decides what
 * to show. Outside a provider everything is allowed, so components rendered
 * elsewhere behave as before.
 */
export type PermsData = {
  keys: string[];
  apps: string[];
  limits: Record<string, number | null>;
  isOwner: boolean;
  plan: string;
  roles: { id: string; name: string; builtin: string | null }[];
  preview: { roleId: string; name: string } | null;
  canManage: boolean;
};

type Perms = PermsData & {
  provided: boolean;
  can: (key: string) => boolean;
  opens: (app: string) => boolean;
  limit: (key: string) => number | null;
  /** The Builder switch: Plan, Build and every builder feature. */
  builder: boolean;
};

const Ctx = createContext<PermsData | null>(null);

export function PermsProvider({ value, children }: { value: PermsData | null; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePerms(): Perms {
  const v = useContext(Ctx);
  return useMemo(() => {
    if (!v) {
      return {
        keys: [],
        apps: [],
        limits: {},
        isOwner: false,
        plan: "FREE",
        roles: [],
        preview: null,
        canManage: false,
        provided: false,
        can: () => true,
        opens: () => true,
        limit: () => null,
        builder: true,
      };
    }
    const keys = new Set(v.keys);
    const apps = new Set(v.apps);
    return {
      ...v,
      provided: true,
      can: (k: string) => keys.has(k),
      opens: (a: string) => apps.has(a),
      limit: (k: string) => (k in v.limits ? v.limits[k] : 0),
      builder: keys.has("builder.open"),
    };
  }, [v]);
}
