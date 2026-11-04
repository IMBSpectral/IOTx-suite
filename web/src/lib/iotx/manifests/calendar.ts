import type { AppManifest } from "../types";

/** IOTx Workspace Calendar (apps/workspace, mounted at /workspace). */
export const calendar: AppManifest = {
  id: "calendar",
  name: "Calendar",
  desc: "Your schedule",
  color: "linear-gradient(135deg,#4338ca,#818cf8)",
  icon: "calendar",
  status: "live",
  href: "/workspace/calendar",
  mountPath: "/workspace/calendar",
  source: "apps/workspace",
  order: 11,
  features: [
    { key: "calendar.create", label: "Create events", group: "Calendar" },
    { key: "calendar.google", label: "Sync with Google Calendar", group: "Calendar", hint: "Two-way sync of their primary Google calendar" },
    { key: "calendar.team", label: "Create team calendars", group: "Calendar", hint: "Calendars everyone in the workspace can see" },
  ],
  roadmap: ["Microsoft calendars", "Meetings booked by the AI"],
};
