import type { AppManifest } from "../types";

/** The person's own Google Drive, through the Google account they connect (the same one Docs, Sheets and Slides use). */
export const gdrive: AppManifest = {
  id: "gdrive",
  name: "Google Drive",
  desc: "Your Google Drive",
  color: "linear-gradient(135deg,#1a73e8,#34a853 55%,#fbbc04)",
  icon: "gdrive",
  status: "live",
  href: "/gdrive",
  mountPath: "/gdrive",
  order: 10.5,
  features: [
    { key: "gdrive.download", label: "Download files", group: "Google Drive", defaults: ["owner", "admin", "member"] },
    { key: "gdrive.copy", label: "Copy files into Files", group: "Google Drive", hint: "Uses the company's Files storage", defaults: ["owner", "admin", "member"] },
  ],
  roadmap: ["Upload from the suite into Google Drive", "Shared drives browser"],
};
