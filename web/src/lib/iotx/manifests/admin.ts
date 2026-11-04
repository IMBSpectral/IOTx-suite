import type { AppManifest } from "../types";

/** Admin: people, roles and permissions, billing, audit and sign-in. */
export const admin: AppManifest = {
  id: "admin",
  name: "Admin",
  desc: "Roles & permissions",
  color: "linear-gradient(135deg,#334155,#64748b)",
  icon: "admin",
  status: "live",
  href: "/admin/roles",
  order: 16,
  features: [
    { key: "admin.people", label: "Manage people", group: "Organization" },
    { key: "admin.roles", label: "Manage roles and permissions", group: "Organization", risk: true },
    { key: "admin.billing", label: "Billing and plans", group: "Organization" },
    { key: "admin.audit", label: "Audit log", group: "Organization" },
    { key: "admin.sso", label: "Sign-in and SSO", group: "Organization", risk: true },
    { key: "admin.mailboxes", label: "Manage company mailboxes", group: "Organization", hint: "Connect shared mailboxes and help others connect theirs" },
  ],
};
