import type { BuiltinId, Feature } from "./types";
import { openKey, voucherKey } from "./types";
import { ALL_FEATURES, MANIFESTS, appOfKey, manifestById } from "./manifests";

/**
 * Built-in role defaults and role templates. Pure data (no server imports),
 * shared by the permission service and the admin screen.
 *
 * Defaults keep today's behaviour: workspace members have always been able
 * to build, so the built-in Member role keeps the Builder switch and every
 * builder feature on. Guests (the VIEWER membership role) chat with the AI
 * and see what is shared with them. New custom roles start with Ask only.
 */

export const BUILTIN_NAMES: Record<BuiltinId, string> = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest" };
export const BUILTIN_DESC: Record<BuiltinId, string> = {
  owner: "Always has everything. Can't be changed.",
  admin: "Runs the workspace: people, roles, billing and every app.",
  member: "Everyday work in every app, including the Builder.",
  guest: "Chats with the AI and sees what is shared with them.",
};
export const BUILTIN_ORDER: BuiltinId[] = ["owner", "admin", "member", "guest"];

/** Membership.role -> built-in role. */
export const BUILTIN_FOR_MEMBERSHIP: Record<string, BuiltinId> = { OWNER: "owner", ADMIN: "admin", MEMBER: "member", VIEWER: "guest" };

const GUEST_APPS = new Set(["chat", "docs", "files"]);

/** Whether a built-in role has a feature when no admin has changed it. */
export function builtinFeatureDefault(builtin: BuiltinId, f: Feature): boolean {
  if (builtin === "owner") return true;
  if (f.defaults) return f.defaults.includes(builtin);
  const app = appOfKey(f.key);
  if (builtin === "admin") return true;
  if (builtin === "member") {
    if (app === "admin") return false;
    if (app === "builder") return true; // existing members keep every builder feature
    if (f.type === "limit") return false;
    return !f.risk;
  }
  return false; // guest: only what a feature's own defaults list
}

/** Whether a built-in role opens an app when no admin has changed it. */
export function builtinAppDefault(builtin: BuiltinId, app: string): boolean {
  if (builtin === "owner" || builtin === "admin") return true;
  if (builtin === "member") return app !== "admin";
  return GUEST_APPS.has(app);
}

/** The default value of any key (feature or "<app>.open") for a built-in role. */
export function builtinDefault(builtin: BuiltinId, key: string): boolean {
  if (key.endsWith(".open")) return builtinAppDefault(builtin, key.slice(0, -5));
  const f = ALL_FEATURES.find((x) => x.key === key);
  return f ? builtinFeatureDefault(builtin, f) : false;
}

/** A complete perms map for a built-in role's defaults. */
export function builtinPerms(builtin: BuiltinId): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of MANIFESTS) if (!m.alwaysOpen) out[openKey(m.id)] = builtinAppDefault(builtin, m.id);
  for (const f of ALL_FEATURES) if (f.type !== "limit") out[f.key] = builtinFeatureDefault(builtin, f);
  return out;
}

export const BUILTIN_LIMITS: Record<BuiltinId, Record<string, number>> = {
  owner: {},
  admin: {},
  member: {},
  guest: {},
};

/** A new custom role: Ask IOTx and AI Chat only, Builder off. */
export function customRolePerms(): Record<string, boolean> {
  return { "home.ask": true, "home.attach": true, [openKey("chat")]: true, "chat.projects": true, "chat.files": true };
}

// ── Role templates (copy and adjust) ────────────────────────────────────────

export type RoleTemplate = {
  id: string;
  name: string;
  description: string;
  apps: string[];
  keys: string[];
  limits?: Record<string, number>;
  scopes?: Record<string, string>;
};

const keysOf = (app: string, pred: (f: Feature) => boolean = () => true) => {
  const m = manifestById(app);
  if (!m) return [];
  return ALL_FEATURES.filter((f) => appOfKey(f.key) === app && f.type !== "limit" && pred(f)).map((f) => f.key);
};
const VOUCHERS = manifestById("tally")?.vouchers;
const vouchers = (actions: string[]) => (VOUCHERS ? VOUCHERS.types.flatMap((t) => actions.map((a) => voucherKey(t, a))) : []);

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "builder",
    name: "Builder",
    description: "Builds apps with the AI: Plan, Build, Cloud and publishing, without the risky switches.",
    apps: ["builder", "chat", "docs", "sheets", "slides", "store", "tasks", "files", "notes", "read", "mail", "calendar", "meetings"],
    keys: [
      "home.ask",
      "home.web",
      "home.attach",
      ...keysOf("builder", (f) => !f.risk && f.key !== "builder.cloud.secrets" && f.key !== "builder.domain.custom"),
      ...keysOf("chat"),
      ...keysOf("docs", (f) => !f.risk),
      ...keysOf("sheets", (f) => !f.risk),
      ...keysOf("slides"),
      ...keysOf("tasks", (f) => !f.risk),
      ...keysOf("files", (f) => !f.risk),
      "store.use",
      "store.install",
    ],
    limits: { "builder.credits.monthly": 500 },
  },
  {
    id: "accountant",
    name: "Accountant",
    description: "Keeps the books in Accounts: vouchers, masters and every report, within an amount limit.",
    apps: ["tally", "sheets", "docs", "chat", "mail", "calendar", "files", "notes", "tasks", "read"],
    keys: [
      "home.ask",
      "home.attach",
      ...keysOf("chat"),
      "sheets.create",
      "sheets.edit",
      "sheets.comment",
      "sheets.export",
      "sheets.pivot",
      "docs.create",
      "docs.edit",
      "docs.export",
      "tasks.create",
      "files.upload",
      "tally.company.view",
      "tally.masters.view",
      "tally.masters.create",
      "tally.masters.alter",
      ...keysOf("tally", (f) => f.key.startsWith("tally.reports.")),
      "tally.export",
      ...vouchers(["create", "alter"]),
    ],
    limits: { "tally.amount_limit": 500000, "tally.backdate": 7 },
    scopes: { "tally.company": "Assigned per person" },
  },
  {
    id: "sales",
    name: "Sales executive",
    description: "Customers, documents and follow-ups; sales vouchers only.",
    apps: ["chat", "mail", "calendar", "meetings", "docs", "sheets", "files", "notes", "tasks", "store", "read", "tally"],
    keys: ["home.ask", "home.web", "home.attach", ...keysOf("chat"), "docs.create", "docs.edit", "docs.ai", "sheets.edit", "sheets.comment", "tasks.create", "files.upload", "store.use", "tally.company.view", voucherKey("Sales", "create"), voucherKey("Receipt", "create")],
    limits: { "tally.amount_limit": 200000, "tally.backdate": 0 },
    scopes: { "tally.company": "Assigned per person" },
  },
  {
    id: "storekeeper",
    name: "Store keeper",
    description: "Stock items and stock movements; no accounting vouchers.",
    apps: ["tally", "chat", "tasks", "files", "sheets"],
    keys: ["home.ask", ...keysOf("chat"), "tally.company.view", "tally.masters.view", "tally.masters.create", "tally.reports.stock", "tasks.create", "files.upload", "sheets.edit"],
    limits: { "tally.backdate": 1 },
  },
  {
    id: "planthead",
    name: "Plant head",
    description: "Approves purchases and sees every report for their plant.",
    apps: ["tally", "chat", "tasks", "files", "sheets", "docs", "mail", "calendar", "meetings"],
    keys: [
      "home.ask",
      "home.web",
      "home.attach",
      ...keysOf("chat"),
      "tally.company.view",
      "tally.masters.view",
      ...keysOf("tally", (f) => f.key.startsWith("tally.reports.")),
      ...vouchers(["approve"]),
      ...keysOf("tasks"),
      "files.upload",
      "sheets.edit",
      "docs.create",
      "docs.edit",
    ],
    scopes: { "tally.branch": "Assigned per person" },
  },
  {
    id: "dispatch",
    name: "Dispatch clerk",
    description: "Tasks and files for dispatch; asks the AI.",
    apps: ["chat", "tasks", "files", "read", "store"],
    keys: ["home.ask", ...keysOf("chat"), "tasks.create", "files.upload", "store.use"],
  },
];

/** A template as a perms map. */
export function templatePerms(t: RoleTemplate): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const a of t.apps) out[openKey(a)] = true;
  for (const k of t.keys) out[k] = true;
  return out;
}
