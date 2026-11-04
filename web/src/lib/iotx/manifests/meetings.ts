import type { AppManifest } from "../types";

/**
 * IOTx Meet: video meetings on self-hosted LiveKit (apps/workspace, mounted at /workspace/meet).
 * Switch keys start with the app id ("meetings."), as the permission service requires.
 */
export const meetings: AppManifest = {
  id: "meetings",
  name: "Meet",
  desc: "Video meetings",
  color: "linear-gradient(135deg,#0284c7,#38bdf8)",
  icon: "meet",
  status: "live",
  href: "/workspace/meet",
  mountPath: "/workspace/meet",
  source: "apps/workspace",
  order: 12,
  features: [
    { key: "meetings.create", label: "Start and schedule meetings", group: "Meet" },
    { key: "meetings.guests", label: "Invite guests from outside", group: "Meet", hint: "People without an account join with a link and wait until a host admits them" },
    { key: "meetings.record", label: "Record meetings", group: "Meet", risk: true, defaults: ["owner", "admin"], hint: "Hosts only; everyone in the room sees a Recording notice" },
    { key: "meetings.ai_notes", label: "AI meeting notes", group: "Meet", risk: true, defaults: ["owner", "admin"], hint: "Transcribe, summarize and turn action items into tasks (hosts only)" },
  ],
  roadmap: ["Live captions", "Breakout rooms"],
};
