import type { AppManifest } from "../types";

/**
 * The Builder (the existing Forge app builder). Its access switch,
 * builder.open, is the "Builder" toggle: without it the same AI interface
 * offers Ask/chat only; with it Plan, Build and every feature below appear.
 */
export const builder: AppManifest = {
  id: "builder",
  name: "Builder",
  desc: "Create custom apps",
  color: "linear-gradient(135deg,#4f46e5,#8b5cf6)",
  icon: "builder",
  status: "live",
  href: "/dashboard",
  source: "web/",
  order: 1,
  features: [
    { key: "builder.project.create", label: "Create projects", group: "Projects" },
    { key: "builder.project.delete", label: "Delete projects", group: "Projects", risk: true },
    { key: "builder.project.transfer", label: "Move projects between folders and workspaces", group: "Projects" },
    { key: "builder.build", label: "Build mode (changes the app)", group: "Building", hint: "Build, Design and Goal modes, variants, undo and restore" },
    { key: "builder.plan", label: "Plan mode", group: "Building" },
    { key: "builder.visual_edit", label: "Visual edits", group: "Building" },
    { key: "builder.code.view", label: "View code", group: "Building", defaults: ["owner", "admin", "member", "guest"] },
    { key: "builder.code.edit", label: "Edit code", group: "Building", hint: "Code editor, terminal and environment variables" },
    { key: "builder.images", label: "Generate images", group: "Building" },
    { key: "builder.publish", label: "Publish", group: "Publishing" },
    { key: "builder.domain.subdomain", label: "Choose or rename the subdomain", group: "Publishing", hint: "<name>.<platform domain> for a published app" },
    { key: "builder.domain.custom", label: "Connect a custom domain", group: "Publishing", plan: "PRO" },
    { key: "builder.preview_links", label: "Preview links", group: "Publishing" },
    { key: "builder.security.override", label: "Publish despite security findings", group: "Publishing", risk: true },
    { key: "builder.cloud.enable", label: "Turn on Cloud", group: "Cloud (backend)" },
    { key: "builder.cloud.rows", label: "Edit database rows", group: "Cloud (backend)" },
    { key: "builder.cloud.sql", label: "SQL editor", group: "Cloud (backend)", risk: true },
    { key: "builder.cloud.storage", label: "Storage", group: "Cloud (backend)" },
    { key: "builder.cloud.functions", label: "Server functions", group: "Cloud (backend)" },
    { key: "builder.cloud.jobs", label: "Jobs and workflows", group: "Cloud (backend)" },
    { key: "builder.cloud.users", label: "Manage app users", group: "Cloud (backend)" },
    { key: "builder.cloud.secrets", label: "Secrets", group: "Cloud (backend)" },
    { key: "builder.connectors", label: "Use connectors", group: "Integrations" },
    { key: "builder.github", label: "GitHub sync", group: "Integrations" },
    { key: "builder.api_keys", label: "API keys and MCP", group: "Integrations" },
    { key: "builder.browser", label: "Cloud browser", group: "Integrations" },
    { key: "builder.credits.monthly", label: "AI credits per month", group: "Limits", type: "limit", unit: "credits", hint: "Empty means no limit" },
  ],
};
