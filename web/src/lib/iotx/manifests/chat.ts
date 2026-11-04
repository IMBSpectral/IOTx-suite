import type { AppManifest } from "../types";

/** AI Chat: conversations with the IOTx assistant (the workspace assistant). */
export const chat: AppManifest = {
  id: "chat",
  name: "AI Chat",
  desc: "Your AI assistant",
  color: "linear-gradient(135deg,#7c3aed,#c084fc)",
  icon: "chat",
  status: "live",
  href: "/home/chat",
  order: 7,
  features: [
    { key: "chat.projects", label: "Bring projects into a chat", group: "Chats", hint: "Only projects the person can already see", defaults: ["owner", "admin", "member", "guest"] },
    { key: "chat.files", label: "Bring chat files into a chat", group: "Chats", defaults: ["owner", "admin", "member", "guest"] },
  ],
};
