import type { AppManifest } from "../types";

/**
 * Dashboards and folders in the sidebar. Not an app of its own (no launcher
 * entry, no access switch): these switches say who may create and manage them,
 * and the list under them in Admin → Roles says which ones each role sees.
 */
export const spaces: AppManifest = {
  id: "spaces",
  name: "Dashboards & folders",
  desc: "Keep apps and pages in the sidebar",
  color: "linear-gradient(135deg,#0ea5e9,#6366f1)",
  icon: "home",
  status: "live",
  alwaysOpen: true,
  settingsOnly: true,
  order: 90,
  features: [
    { key: "spaces.dashboards.create", label: "Create dashboards", group: "Create", hint: "Make a dashboard and move apps built in the Builder into it", defaults: ["owner", "admin"] },
    { key: "spaces.folders.create", label: "Create folders", group: "Create", hint: "Make folders in the sidebar for quick access", defaults: ["owner", "admin", "member"] },
    { key: "spaces.add", label: "Add apps and links to others' dashboards and folders", group: "Create", hint: "Any they can see. Everyone can add to their own.", defaults: ["owner", "admin"] },
    { key: "spaces.share", label: "Share their own with people and roles", group: "Sharing", hint: "Choose who sees a dashboard or folder they created", defaults: ["owner", "admin", "member"] },
    { key: "spaces.manage", label: "Manage all dashboards and folders", group: "Sharing", risk: true, hint: "See, edit, share and delete every one, whoever made it", defaults: ["owner", "admin"] },
  ],
};
