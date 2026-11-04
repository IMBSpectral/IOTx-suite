import type { AppManifest } from "../types";

export const docs: AppManifest = {
  id: "docs",
  name: "Docs",
  desc: "Write documents",
  color: "linear-gradient(135deg,#3730a3,#a78bfa)",
  icon: "docs",
  status: "live",
  href: "/docs",
  mountPath: "/docs",
  source: "suite/wordcraft",
  order: 2,
  features: [
    { key: "docs.google", label: "Open their Google Docs", group: "Google", hint: "Connect Google Drive and work with their files" },
    { key: "docs.google.edit", label: "Create, edit and delete Google Docs", group: "Google", hint: "New files, rename, copy, move to Trash" },
    { key: "docs.create", label: "Create", group: "Documents" },
    { key: "docs.edit", label: "Edit", group: "Documents" },
    { key: "docs.suggest", label: "Suggest changes", group: "Documents", defaults: ["owner", "admin", "member", "guest"] },
    { key: "docs.share.external", label: "Share outside the company", group: "Documents", risk: true },
    { key: "docs.export", label: "Export to PDF and Word", group: "Documents" },
    { key: "docs.ai", label: "AI writing", group: "Documents" },
  ],
  roadmap: ["A web editor on the wordcraft engine", "Suggestions, comments and version history", "Export to PDF and Word"],
};
