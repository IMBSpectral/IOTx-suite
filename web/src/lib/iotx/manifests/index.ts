import type { AppManifest, Feature } from "../types";
import { openKey, voucherKey } from "../types";
import { home } from "./home";
import { builder } from "./builder";
import { sheets } from "./sheets";
import { docs } from "./docs";
import { slides } from "./slides";
import { tally } from "./tally";
import { tasks } from "./tasks";
import { files } from "./files";
import { store } from "./store";
import { chat } from "./chat";
import { mail } from "./mail";
import { calendar } from "./calendar";
import { meetings } from "./meetings";
import { notes } from "./notes";
import { read } from "./read";
import { admin } from "./admin";
import { teamchat } from "./teamchat";
import { spaces } from "./spaces";

/** Every IOTx app, in launcher order. To add an app: write its manifest and list it here. */
export const MANIFESTS: AppManifest[] = [home, builder, docs, sheets, slides, tally, chat, teamchat, mail, tasks, files, calendar, meetings, notes, store, read, admin, spaces].sort(
  (a, b) => a.order - b.order,
);

export const manifestById = (id: string) => MANIFESTS.find((m) => m.id === id);

/**
 * Apps listed in the shell's sidebar (in this order), when the person can open them.
 * Shared with apps/workspace through GET /api/iotx/shell so both sidebars match.
 */
export const SIDEBAR_APPS = ["builder", "chat", "teamchat", "meetings", "calendar", "tasks", "sheets", "docs", "slides", "read", "tally", "files"];

/** Live apps served by apps/workspace (another process under /workspace): plain links, not client-side routes. */
export const isWorkspaceHref = (href: string) => href === "/workspace" || href.startsWith("/workspace/");

/** The app a key belongs to ("builder.cloud.sql" -> "builder"). */
export const appOfKey = (key: string) => key.split(".")[0];

/** Every feature of an app, with the voucher matrix expanded into switches. */
export function featuresOf(m: AppManifest): Feature[] {
  const out = [...m.features];
  if (m.vouchers) {
    for (const t of m.vouchers.types)
      for (const a of m.vouchers.actions) out.push({ key: voucherKey(t, a), label: `${t}: ${a}`, group: "Vouchers", risk: a === "delete" });
  }
  return out;
}

/** Every key the platform knows: app access switches, then features. */
export const ALL_FEATURES: Feature[] = MANIFESTS.flatMap(featuresOf);
export const FEATURE_BY_KEY = new Map(ALL_FEATURES.map((f) => [f.key, f]));
export const APP_KEYS = MANIFESTS.filter((m) => !m.alwaysOpen).map((m) => openKey(m.id));
export const ALL_KEYS = new Set<string>([...APP_KEYS, ...ALL_FEATURES.map((f) => f.key)]);
export const isKnownKey = (key: string) => ALL_KEYS.has(key);

/** Label for any key, for messages ("Your role doesn't include Publish"). */
export function keyLabel(key: string) {
  const f = FEATURE_BY_KEY.get(key);
  if (f) return f.label;
  if (key.endsWith(".open")) {
    const m = manifestById(key.slice(0, -5));
    if (m) return m.id === "builder" ? "Builder" : `Open ${m.name}`;
  }
  return key;
}
