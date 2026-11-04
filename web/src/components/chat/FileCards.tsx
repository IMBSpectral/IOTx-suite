"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import FileIcon from "../code/FileIcon";
import { useDarkTheme } from "../code/media";
import "../build-overlay.css";

const MiniCode = dynamic(() => import("../code/MiniCode"), { ssr: false });

/** The file the agent is writing right now, streamed as it is written. */
export type LiveFile = { path: string; content: string; done: boolean };

/**
 * Each file a turn writes, as a compact card like Lovable's: "Editing
 * src/pages/Index.tsx" with a spinner while it is written, then "Edited" (or
 * "Created") with a check. Expanding a card shows the file's code
 * highlighted: streaming in while it is written, then the saved file.
 */
export default function FileCards({
  projectId,
  steps,
  live,
  files,
  canView,
  onOpenPath,
}: {
  projectId: string;
  /** The message's raw steps ("write:src/App.tsx", "new:src/App.tsx", …). */
  steps: string[];
  live: LiveFile | null;
  files?: string[];
  canView: boolean;
  onOpenPath: (path: string) => void;
}) {
  const [all, setAll] = useState(false);
  const written = steps.filter((s) => s.startsWith("write:")).map((s) => s.slice(6));
  const paths = written.filter((p, i) => written.indexOf(p) === i);
  if (live && !live.done && !paths.includes(live.path)) paths.push(live.path);
  if (!paths.length) return null;
  const created = new Set(steps.filter((s) => s.startsWith("new:")).map((s) => s.slice(4)));
  const writing = live && !live.done ? live.path : null;
  const shown = all || paths.length <= 6 || writing ? paths : paths.slice(0, 4);
  return (
    <ul className="mt-2 space-y-1" aria-label="Files changed">
      {shown.map((p) => (
        <FileCard
          key={p}
          projectId={projectId}
          path={p}
          writing={writing === p}
          verb={writing === p ? (files?.includes(p) ? "Editing" : "Creating") : created.has(p) ? "Created" : "Edited"}
          live={live?.path === p ? live : null}
          canView={canView}
          onOpenPath={onOpenPath}
        />
      ))}
      {shown.length < paths.length && (
        <li>
          <button onClick={() => setAll(true)} className="text-[11px] hover:underline" style={{ color: "var(--muted)" }}>
            Show all {paths.length} files
          </button>
        </li>
      )}
    </ul>
  );
}

function FileCard({
  projectId,
  path,
  writing,
  verb,
  live,
  canView,
  onOpenPath,
}: {
  projectId: string;
  path: string;
  writing: boolean;
  verb: string;
  live: LiveFile | null;
  canView: boolean;
  onOpenPath: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() ?? path;
  const dir = path.slice(0, path.length - name.length);
  return (
    <li className="overflow-hidden rounded-lg border text-[12px]" style={{ background: "var(--panel)" }}>
      <div className="flex h-8 items-center gap-1.5 pl-1.5 pr-2">
        <button
          type="button"
          onClick={() => canView && setOpen((o) => !o)}
          disabled={!canView}
          aria-expanded={canView ? open : undefined}
          title={canView ? (open ? "Hide the code" : "Show the code") : path}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left disabled:cursor-default"
        >
          {canView && <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} style={{ color: "var(--muted)" }} />}
          {writing ? (
            <Loader2 className="fc-spin h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} aria-label="Writing" />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="Done" />
          )}
          <span className="shrink-0" style={{ color: "var(--muted)" }}>{verb}</span>
          <FileIcon path={path} />
          <span className="min-w-0 truncate font-mono text-[11.5px]" title={path}>
            <span style={{ color: "var(--muted)" }}>{dir}</span>
            {name}
          </span>
        </button>
        {canView && !writing && (
          <button type="button" onClick={() => onOpenPath(path)} className="shrink-0 text-[11px] hover:underline" style={{ color: "var(--accent)" }}>
            View code
          </button>
        )}
      </div>
      {open && canView && <FileCardCode projectId={projectId} path={path} live={live} writing={writing} />}
    </li>
  );
}

/** The card's code: the streamed text while it is written, else the saved file. */
function FileCardCode({ projectId, path, live, writing }: { projectId: string; path: string; live: LiveFile | null; writing: boolean }) {
  const dark = useDarkTheme();
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const streamed = live?.content ?? "";
  // Fetched once the write lands (or straight away for an earlier file).
  const needFetch = !writing && !(live?.done && streamed);
  useEffect(() => {
    if (!needFetch) return;
    let on = true;
    fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!on) return;
        if (!r.ok) return setFailed(true);
        const d = (await r.json()) as { content?: string };
        if (on) setSaved(d.content ?? "");
      })
      .catch(() => on && setFailed(true));
    return () => {
      on = false;
    };
  }, [projectId, path, needFetch]);
  const code = needFetch ? saved : streamed;
  if (failed) {
    return (
      <p className="border-t px-3 py-2 text-[11px]" style={{ color: "var(--muted)" }}>
        Couldn&apos;t load this file (it may have been moved or deleted).
      </p>
    );
  }
  if (code === null) {
    return (
      <p className="border-t px-3 py-2 text-[11px]" style={{ color: "var(--muted)" }}>
        Loading…
      </p>
    );
  }
  const lines = code.split("\n").length;
  return (
    <div className="border-t" style={{ height: Math.min(16 + lines * 18.4, 260) }}>
      <MiniCode key={path} path={path} code={code} dark={dark} follow={writing} />
    </div>
  );
}
