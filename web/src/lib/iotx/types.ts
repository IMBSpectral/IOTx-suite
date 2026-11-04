/**
 * IOTx app manifests: every app declares its features (switches and numeric
 * limits), groups, risk, plan gating and data scopes in one small file under
 * lib/iotx/manifests. The permission service and the admin Roles screen are
 * generated from these, so a new feature only needs a new manifest entry.
 *
 * Plain data, no server imports: the client (launcher, admin screen) uses it too.
 */

export type PlanId = "FREE" | "PRO" | "BUSINESS" | "ENTERPRISE";
export const PLAN_RANK: Record<PlanId, number> = { FREE: 0, PRO: 1, BUSINESS: 2, ENTERPRISE: 3 };
export const PLAN_LABEL: Record<PlanId, string> = { FREE: "Free", PRO: "Pro", BUSINESS: "Business", ENTERPRISE: "Enterprise" };

/** The four built-in roles; each workspace membership maps onto one of them. */
export type BuiltinId = "owner" | "admin" | "member" | "guest";

export type Feature = {
  /** Globally unique, "<app>.<feature>" (e.g. builder.cloud.sql). */
  key: string;
  label: string;
  group: string;
  /** A switch (default) or a numeric limit ("no limit" when empty). */
  type?: "switch" | "limit";
  /** Unit shown next to a limit (credits, INR, days). */
  unit?: string;
  /** Risky features are badged in the admin screen and default off for Members of other apps. */
  risk?: boolean;
  /** Lowest plan that includes the feature; below it the switch is locked with "Upgrade". */
  plan?: PlanId;
  /** One line under the label in the admin screen. */
  hint?: string;
  /** Built-in roles that have it by default (overrides the general rule in permissions.ts). */
  defaults?: BuiltinId[];
};

export type Scope = { key: string; label: string; options: string[] };

export type AppManifest = {
  id: string;
  name: string;
  /** Short line for the launcher. */
  desc: string;
  /** Icon gradient. */
  color: string;
  /** Icon id from lib/iotx/icons. */
  icon: string;
  /** live: opens inside IOTx today. soon: shows the Coming soon page. */
  status: "live" | "soon";
  /** Where a live app opens. */
  href?: string;
  /** Where the app will mount under the one IOTx domain once integrated. */
  mountPath?: string;
  /** Where its code lives today (for the Coming soon page and the docs). */
  source?: string;
  /** Home has no access switch: everyone in the workspace has it. */
  alwaysOpen?: boolean;
  /** Only in Admin → Roles: not an app to open (no launcher, search or start page entry). */
  settingsOnly?: boolean;
  /** Launcher order. */
  order: number;
  features: Feature[];
  scopes?: Scope[];
  /** Tally only: voucher types x actions become a matrix of switches. */
  vouchers?: { types: string[]; actions: string[] };
  /** Shown on the Coming soon page. */
  roadmap?: string[];
};

/** Key of the app-access switch for an app ("builder.open" is the Builder switch). */
export const openKey = (app: string) => `${app}.open`;

export const voucherKey = (type: string, action: string) =>
  `tally.voucher.${type.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.${action}`;
