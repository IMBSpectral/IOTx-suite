"use client";

import { X } from "lucide-react";
import { useEscape } from "../useEscape";
import type { Task } from "./types";

const COLUMNS: { status: Task["status"]; label: string }[] = [
  { status: "in_progress", label: "In progress" },
  { status: "todo", label: "To do" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

/** The agent's task list for this project, kept current by update_tasks. */
export default function TaskPanel({
  open,
  tasks,
  onClose,
}: {
  open: boolean;
  tasks: Task[];
  onClose: () => void;
}) {
  useEscape(open ? onClose : null);
  if (!open) return null;
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <div
      role="dialog"
      aria-label="Task list"
      className="absolute inset-y-0 left-0 z-30 flex w-[420px] flex-col border-r shadow-xl"
      style={{ background: "var(--bg, white)" }}
    >
      <header className="flex h-12 items-center justify-between border-b px-4">
        <div>
          <h2 className="text-sm font-medium">Tasks</h2>
          {tasks.length > 0 && (
            <p className="text-[11px]" style={{ color: "var(--muted)" }}>
              {done} of {tasks.length} done
            </p>
          )}
        </div>
        <button onClick={onClose} aria-label="Close tasks" className="rounded-md p-1 hover:bg-black/[.05]">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {tasks.length === 0 && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No tasks yet. For multi-step work the agent lays out a task list here and ticks it off as it goes.
          </p>
        )}
        {COLUMNS.map((c) => {
          const items = tasks.filter((t) => t.status === c.status);
          if (items.length === 0) return null;
          return (
            <section key={c.status}>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                {c.label} · {items.length}
              </h3>
              <ul className="space-y-1">
                {items.map((t, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
                    <span
                      aria-hidden
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        t.status === "done"
                          ? "bg-emerald-500"
                          : t.status === "in_progress"
                            ? "bg-amber-500"
                            : t.status === "blocked"
                              ? "bg-red-500"
                              : "bg-zinc-300"
                      }`}
                    />
                    <span className={t.status === "done" ? "line-through opacity-60" : ""}>{t.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
