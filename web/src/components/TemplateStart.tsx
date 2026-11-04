"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const STYLES = [
  ["", "Default"],
  ["minimal", "Minimal"],
  ["bold", "Bold"],
  ["playful", "Playful"],
  ["elegant", "Elegant"],
] as const;

/** "Remix" a template with a chosen style, then open the editor. */
export default function TemplateStart({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const [style, setStyle] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, template: slug, style }),
    });
    if (!res.ok) {
      setBusy(false);
      return;
    }
    const { project, seed } = await res.json();
    if (seed) sessionStorage.setItem(`seed:${project.id}`, seed);
    router.push(`/projects/${project.id}`);
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Style">
        {STYLES.map(([v, l]) => (
          <button
            key={v}
            role="radio"
            aria-checked={style === v}
            onClick={() => setStyle(v)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${style === v ? "border-[#6d4aff] bg-[#6d4aff]/10 font-medium" : ""}`}
          >
            {l}
          </button>
        ))}
      </div>
      <button
        onClick={start}
        disabled={busy}
        className="mt-3 w-full rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        style={{ background: "var(--accent)" }}
      >
        {busy ? "Creating…" : style ? `Remix with the ${STYLES.find(([v]) => v === style)?.[1] ?? style} style` : "Remix with the default style"}
      </button>
      {style && (
        <button onClick={() => setStyle("")} className="mt-1.5 w-full text-xs hover:underline" style={{ color: "var(--muted)" }}>
          Reset to original style
        </button>
      )}
    </div>
  );
}
