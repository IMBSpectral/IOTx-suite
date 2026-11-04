import type { AppManifest } from "../types";

export const store: AppManifest = {
  id: "store",
  name: "Store",
  desc: "Templates & apps",
  color: "linear-gradient(135deg,#e11d48,#fb7185)",
  icon: "store",
  status: "soon",
  mountPath: "/store",
  order: 14,
  features: [
    { key: "store.use", label: "Use company apps", group: "Store" },
    { key: "store.install", label: "Install templates", group: "Store" },
    { key: "store.publish", label: "List apps in the company Store", group: "Store", risk: true },
  ],
  roadmap: ["Company apps built in the Builder", "IOTx templates", "Add new: connect outside apps"],
};
