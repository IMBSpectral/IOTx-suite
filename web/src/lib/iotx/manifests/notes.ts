import type { AppManifest } from "../types";

export const notes: AppManifest = {
  id: "notes",
  name: "Notes",
  desc: "Quick notes",
  color: "linear-gradient(135deg,#9333ea,#e879f9)",
  icon: "notes",
  status: "soon",
  mountPath: "/notes",
  order: 13,
  features: [
    { key: "notes.create", label: "Create notes", group: "Notes" },
    { key: "notes.share", label: "Share notes", group: "Notes" },
  ],
  roadmap: ["Quick notes that the AI can search"],
};
