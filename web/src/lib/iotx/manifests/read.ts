import type { AppManifest } from "../types";

/** Knowledge: the company knowledge base every AI in the suite answers from (web/src/lib/kb.ts). */
export const read: AppManifest = {
  id: "read",
  name: "Knowledge",
  desc: "Company knowledge base",
  color: "linear-gradient(135deg,#1d4ed8,#6366f1)",
  icon: "read",
  status: "live",
  href: "/knowledge",
  mountPath: "/knowledge",
  order: 15,
  features: [
    { key: "read.view", label: "Read articles (and let the AI use them)", group: "Knowledge", hint: "Each article's own audience still applies", defaults: ["owner", "admin", "member", "guest"] },
    { key: "read.ask", label: "Ask the knowledge base with AI", group: "Knowledge", defaults: ["owner", "admin", "member", "guest"] },
    { key: "read.suggest", label: "Suggest updates", group: "Knowledge", hint: "Suggestions wait for a reviewer", defaults: ["owner", "admin", "member"] },
    { key: "read.publish", label: "Write, upload and edit articles", group: "Knowledge", defaults: ["owner", "admin"] },
    { key: "read.review", label: "Approve suggested updates", group: "Knowledge", risk: true, hint: "Including what the AI learns from chats and builds", defaults: ["owner", "admin"] },
  ],
};
