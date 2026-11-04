import type { AppManifest } from "../types";

/** IOTx Workspace Team Chat: channels and direct messages (apps/workspace). "chat" is the AI Chat. */
export const teamchat: AppManifest = {
  id: "teamchat",
  name: "Chat",
  desc: "Channels & messages",
  color: "linear-gradient(135deg,#0891b2,#22d3ee)",
  icon: "chat",
  status: "live",
  href: "/workspace/chat",
  mountPath: "/workspace/chat",
  source: "apps/workspace",
  order: 8,
  features: [
    { key: "teamchat.channel.create", label: "Create channels", group: "Chat" },
    { key: "teamchat.private", label: "Create private channels", group: "Chat" },
    { key: "teamchat.ai", label: "Summarize threads with AI", group: "Chat" },
    { key: "teamchat.admin", label: "Manage any channel and message", group: "Chat", risk: true, defaults: ["owner", "admin"], hint: "Delete any message, remove people, archive channels, set retention, export" },
  ],
};
