import type { AppManifest } from "../types";

/** IOTx Workspace Tasks (apps/workspace, mounted at /workspace). */
export const tasks: AppManifest = {
  id: "tasks",
  name: "Tasks",
  desc: "Projects & boards",
  color: "linear-gradient(135deg,#16a34a,#4ade80)",
  icon: "tasks",
  status: "live",
  href: "/workspace/tasks",
  mountPath: "/workspace/tasks",
  source: "apps/workspace",
  order: 9,
  features: [
    { key: "tasks.project.create", label: "Create projects", group: "Work" },
    { key: "tasks.create", label: "Create tasks", group: "Work" },
    { key: "tasks.assign", label: "Assign to others", group: "Work" },
    { key: "tasks.delete", label: "Delete tasks", group: "Work", risk: true },
  ],
  roadmap: ["Sprints and custom workflows", "Tasks created by the AI from chats"],
};
