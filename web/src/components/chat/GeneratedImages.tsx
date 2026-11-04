"use client";

import type { Step } from "./types";

const IMAGE = /^(public|src\/assets|assets)\/.+\.(png|jpe?g|webp|gif|avif)$/i;

/**
 * Images the agent made in this turn, shown in the chat as they land (while
 * the app is still building, as on Lovable). Served from the Files library.
 */
export default function GeneratedImages({ projectId, steps }: { projectId: string; steps: Step[] }) {
  const paths = [
    ...new Set(steps.filter((s): s is Extract<Step, { path: string }> => s.kind === "write" && IMAGE.test(s.path)).map((s) => s.path)),
  ].slice(0, 6);
  if (!paths.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" aria-label="Generated images">
      {paths.map((p) => (
        <a key={p} href={`/api/projects/${projectId}/library?key=${encodeURIComponent(`project:${p}`)}`} target="_blank" rel="noreferrer" title={p}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/projects/${projectId}/library?key=${encodeURIComponent(`project:${p}`)}`}
            alt={p.split("/").pop() ?? "Generated image"}
            loading="lazy"
            className="h-24 w-36 rounded-lg border object-cover"
          />
        </a>
      ))}
    </div>
  );
}
