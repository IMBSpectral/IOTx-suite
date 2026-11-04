"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { categoryOf } from "./chat/AttachmentView";

type File = { id: string; name: string; type: string; size: number; at: string; projectId: string; projectName: string };

/** The workspace's chat attachments, filterable by kind, each with "Ask about this file". */
export default function ChatFiles({ files }: { files: File[] }) {
  const [kind, setKind] = useState("All");
  const [q, setQ] = useState("");
  const kinds = useMemo(() => ["All", ...new Set(files.map((f) => categoryOf(f).label))], [files]);
  const shown = files.filter(
    (f) => (kind === "All" || categoryOf(f).label === kind) && (!q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const muted = { color: "var(--muted)" };

  if (!files.length) {
    return (
      <p className="mt-8 rounded-xl border border-dashed px-6 py-14 text-center text-sm" style={muted}>
        Files you attach in a project&apos;s chat show up here.
      </p>
    );
  }
  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="File kind">
          {kinds.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={`h-7 rounded-lg px-2.5 text-[13px] ${kind === k ? "bg-black/[.07] font-medium dark:bg-white/[.1]" : "hover:bg-black/[.04]"}`}
              style={kind === k ? undefined : muted}
            >
              {k}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
          className="ml-auto w-56 rounded-lg border bg-transparent px-3 py-1.5 text-sm"
        />
      </div>
      <ul className="mt-4 divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
        {shown.map((f) => {
          const { label, Icon } = categoryOf(f);
          return (
            <li key={`${f.projectId}:${f.id}`} className="flex items-center gap-3 px-4 py-3">
              <Icon className="h-5 w-5 shrink-0" style={muted} />
              <div className="min-w-0 flex-1">
                <a href={`/api/projects/${f.projectId}/uploads/${f.id}`} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
                  {f.name}
                </a>
                <p className="truncate text-xs" style={muted}>
                  {label} · {f.projectName} · {formatDistanceToNow(new Date(f.at), { addSuffix: true })}
                </p>
              </div>
              <a href={`/projects/${f.projectId}?ask=${f.id}`} className="shrink-0 rounded-lg border px-2.5 py-1 text-xs">
                Ask about this file
              </a>
            </li>
          );
        })}
        {!shown.length && (
          <li className="px-4 py-6 text-center text-sm" style={muted}>
            No files match.
          </li>
        )}
      </ul>
    </div>
  );
}
