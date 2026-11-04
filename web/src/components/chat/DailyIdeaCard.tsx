"use client";

import { useEffect, useState } from "react";
import { Lightbulb, X } from "lucide-react";

type Idea = { title: string; why: string; prompt: string };

/**
 * Today's build idea for the project, above the composer once the app has
 * some work in it: send it to chat, hide it for today, or turn ideas off.
 */
export default function DailyIdeaCard({ projectId, show, onSend }: { projectId: string; show: boolean; onSend: (text: string) => void }) {
  const [idea, setIdea] = useState<Idea | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (!show) return;
    let live = true;
    fetch(`/api/projects/${projectId}/idea`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setIdea(d?.idea ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, show]);

  if (!show || !idea) return null;
  const hide = (action: "dismiss" | "off") => {
    setIdea(null);
    void fetch(`/api/projects/${projectId}/idea`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
  };

  return (
    <div className="mx-3 mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs" style={{ background: "var(--panel)" }} role="note" aria-label="Today's idea">
      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} />
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">Today&apos;s idea: {idea.title}</span>
        </p>
        {idea.why && <p style={{ color: "var(--muted)" }}>{idea.why}</p>}
        <button
          onClick={() => {
            onSend(idea.prompt);
            hide("dismiss");
          }}
          className="mt-1 font-medium underline"
        >
          Send to chat
        </button>
      </div>
      <div className="relative">
        <button onClick={() => setMenu(!menu)} aria-label="Hide ideas" aria-expanded={menu} className="rounded p-0.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
          <X className="h-3.5 w-3.5" />
        </button>
        {menu && (
          <div className="absolute bottom-6 right-0 z-20 w-44 rounded-lg border p-1 shadow-lg" style={{ background: "var(--panel)" }} role="menu">
            <button role="menuitem" onClick={() => hide("dismiss")} className="block w-full rounded px-2 py-1 text-left hover:bg-black/[.05] dark:hover:bg-white/[.06]">
              Hide for today
            </button>
            <button role="menuitem" onClick={() => hide("off")} className="block w-full rounded px-2 py-1 text-left hover:bg-black/[.05] dark:hover:bg-white/[.06]">
              Turn off ideas for this project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
