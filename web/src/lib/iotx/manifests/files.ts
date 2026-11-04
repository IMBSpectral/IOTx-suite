import type { AppManifest } from "../types";

export const files: AppManifest = {
  id: "files",
  name: "Files",
  desc: "Store & organize",
  color: "linear-gradient(135deg,#2563eb,#93c5fd)",
  icon: "files",
  status: "live",
  href: "/drive",
  mountPath: "/drive",
  order: 10,
  features: [
    { key: "files.upload", label: "Upload", group: "Files" },
    { key: "files.share.external", label: "Share links outside the company", group: "Files", risk: true },
    { key: "files.delete", label: "Delete", group: "Files", risk: true },
    { key: "files.restricted", label: "See restricted folders", group: "Files", risk: true },
  ],
  scopes: [{ key: "files.department", label: "Department folders", options: ["All departments", "Their own department"] }],
  roadmap: ["Department folders with restricted access", "Folder downloads as .zip", "Version history"],
};
