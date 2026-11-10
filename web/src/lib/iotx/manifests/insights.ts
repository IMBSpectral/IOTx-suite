import type { AppManifest } from "../types";

export const insights: AppManifest = {
  id: "insights",
  name: "Insights",
  desc: "Analyse any data with AI",
  color: "linear-gradient(135deg,#7c3aed,#06b6d4)",
  icon: "insights",
  status: "live",
  href: "/insights",
  mountPath: "/insights",
  order: 3.5,
  features: [
    { key: "insights.upload", label: "Add data files", group: "Insights", hint: "Excel, CSV, Word, PDF, PowerPoint, JSON, text", defaults: ["owner", "admin", "member"] },
    { key: "insights.ai", label: "Analyse with AI", group: "Insights", hint: "Uses credits", defaults: ["owner", "admin", "member"] },
  ],
  roadmap: [
    "Forecasts, key drivers and what-if",
    "Network maps, bottlenecks and process flows, anomalies",
    "Shared boards, scheduled refresh and live data sources",
  ],
};
