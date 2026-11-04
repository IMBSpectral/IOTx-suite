"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";
import type { SetupItem } from "@/lib/setup-review";

/** "Review project setup": what to check before publishing, with where to fix it. */
export default function SetupReview({ projectId, open }: { projectId: string; open: boolean }) {
  const [items, setItems] = useState<SetupItem[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch(`/api/projects/${projectId}/setup-review`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setItems(d.items))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, open]);

  if (!items) return null;
  const todo = items.filter((i) => i.status !== "ok").length;
  const where: Record<string, string> = { cloud: "Cloud tab", security: "Security tab", settings: "Project settings", publish: "SEO below", chat: "the chat" };
  return (
    <section aria-label="Review project setup" className="rounded-xl border px-3 py-2 text-xs">
      <button onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} className="flex w-full items-center justify-between">
        <span className="font-medium">Review project setup</span>
        <span className={todo ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
          {todo ? `${todo} to check` : "All set"}
        </span>
      </button>
      {(expanded || todo > 0) && (
        <ul className="mt-2 space-y-1.5">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-2">
              {i.status === "ok" ? (
                <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600" />
              ) : i.status === "todo" ? (
                <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" />
              ) : (
                <CircleDashed className="mt-px h-3.5 w-3.5 shrink-0" style={{ color: "var(--muted)" }} />
              )}
              <span className="min-w-0">
                <span className="font-medium">{i.label}</span> <span style={{ color: "var(--muted)" }}>{i.detail}</span>
                {i.status !== "ok" && i.tab && where[i.tab] && <span style={{ color: "var(--muted)" }}> Fix it in {where[i.tab]}.</span>}
                {i.id === "maps" && i.status !== "ok" && <MapsKeyForm projectId={projectId} onSaved={() => setItems((all) => all && all.map((x) => (x.id === "maps" ? { ...x, status: "ok", detail: "The app uses your own Google Maps API key." } : x)))} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Google Maps Platform setup: the app's own key, kept in its environment variables. */
function MapsKeyForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="mt-1.5 space-y-1"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        const r = await fetch(`/api/projects/${projectId}/env`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ set: [{ name: "VITE_GOOGLE_MAPS_API_KEY", value: key.trim() }] }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return setError(d.error ?? "Couldn't save the key");
        setKey("");
        onSaved();
      }}
    >
      <span className="block" style={{ color: "var(--muted)" }}>
        Create a browser key in Google Cloud (Maps JavaScript API), restrict it to your domain, then paste it here. It&apos;s
        used on your next publish.
      </span>
      <span className="flex gap-1.5">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" aria-label="Google Maps API key" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1" />
        <button disabled={key.trim().length < 10} className="rounded-md border px-2 py-1 disabled:opacity-50">
          Save key
        </button>
      </span>
      {error && <span className="block text-red-500">{error}</span>}
    </form>
  );
}
