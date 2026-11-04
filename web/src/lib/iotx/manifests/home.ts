import type { AppManifest } from "../types";

/** Home and the AI: the landing page and "Ask IOTx". Everyone in the workspace has it. */
export const home: AppManifest = {
  id: "home",
  name: "Home & AI",
  desc: "Your start page and AI",
  color: "linear-gradient(135deg,#4f46e5,#8b5cf6)",
  icon: "home",
  status: "live",
  href: "/home",
  alwaysOpen: true,
  order: 0,
  features: [
    { key: "home.ask", label: "Ask IOTx", group: "Asking IOTx", hint: "Chat and discuss with the AI", defaults: ["owner", "admin", "member", "guest"] },
    { key: "home.web", label: "Web search", group: "Asking IOTx" },
    { key: "home.deep_research", label: "Deep Research", group: "Asking IOTx", plan: "BUSINESS" },
    { key: "home.attach", label: "Attach files", group: "Asking IOTx", defaults: ["owner", "admin", "member", "guest"] },
  ],
};
