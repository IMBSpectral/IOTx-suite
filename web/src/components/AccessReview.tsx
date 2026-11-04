"use client";

import { useEffect, useState } from "react";
import { useEscape } from "./useEscape";
import { X } from "lucide-react";

type Row = {
  id: string;
  name: string;
  visibility: string;
  collaborators: { email: string; name: string | null; role: string }[];
  inviteLink: string;
  previewLinks: number;
  site: string;
};

/** "Review access" for the selected projects. */
export default function AccessReview({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = ids.join(",");
  useEscape(onClose);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/access-review?ids=${key}`)
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => live && setRows(d.projects))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [key]);

  const muted = { color: "var(--muted)" };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-label="Review access" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl" style={{ background: "var(--panel)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 items-center justify-between border-b px-4 text-sm">
          <span className="font-medium">Review access · {ids.length} project{ids.length === 1 ? "" : "s"}</span>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-xs">
          {!rows ? (
            <p style={muted}>Loading…</p>
          ) : (
            <ul className="space-y-3">
              {rows.map((r) => (
                <li key={r.id} className="rounded-xl border p-3">
                  <p className="text-sm font-medium">{r.name}</p>
                  <dl className="mt-1.5 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    <div><dt className="inline" style={muted}>Who can see it: </dt><dd className="inline">{r.visibility}</dd></div>
                    <div><dt className="inline" style={muted}>Invite link: </dt><dd className="inline">{r.inviteLink}</dd></div>
                    <div><dt className="inline" style={muted}>Preview links: </dt><dd className="inline">{r.previewLinks} active</dd></div>
                    <div><dt className="inline" style={muted}>Site: </dt><dd className="inline">{r.site}</dd></div>
                  </dl>
                  <p className="mt-1.5" style={muted}>
                    {r.collaborators.length ? "Shared with: " : "Not shared with anyone outside the workspace."}
                    {r.collaborators.map((c) => `${c.name ?? c.email} (${c.role.toLowerCase()})`).join(", ")}
                  </p>
                  <a href={`/projects/${r.id}`} className="mt-1 inline-block underline">
                    Open to change sharing
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
