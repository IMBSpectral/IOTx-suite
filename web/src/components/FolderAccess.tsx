"use client";

import { useCallback, useEffect, useState } from "react";
import { useEscape } from "./useEscape";
import { Lock, X } from "lucide-react";

type Person = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  canSee: boolean;
  member: boolean;
};
type Info = {
  folder: { id: string; name: string; restricted: boolean };
  inheritedFrom: { id: string; name: string } | null;
  canManage: boolean;
  people: Person[];
};

/** "View access" for a folder: who can see the projects inside, and (for admins) restricting it. */
export default function FolderAccess({
  folderId,
  onClose,
  onChanged,
}: {
  folderId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  useEscape(onClose);

  const load = useCallback(
    () =>
      fetch(`/api/folders?access=${folderId}`)
        .then((r) =>
          r.ok ? r.json() : Promise.reject(new Error("Couldn't load access")),
        )
        .then(setInfo)
        .catch((e) => setError(String(e.message ?? e))),
    [folderId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setError("");
    const res = await fetch("/api/folders", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: folderId, ...body }),
    });
    if (!res.ok)
      setError((await res.json().catch(() => ({}))).error ?? "Couldn't save");
    await load();
    onChanged();
  }

  const muted = { color: "var(--muted)" };
  const ruledHere = info && !info.inheritedFrom;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-label="Folder access"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ background: "var(--panel)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 items-center justify-between border-b px-4 text-sm">
          <span className="font-medium">
            Access · {info?.folder.name ?? "Folder"}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          {!info ? (
            <p style={muted}>{error || "Loading…"}</p>
          ) : (
            <>
              {info.inheritedFrom ? (
                <p className="flex items-center gap-1.5 rounded-lg border p-2">
                  <Lock className="h-3.5 w-3.5" /> Access comes from the
                  restricted folder “{info.inheritedFrom.name}”.
                </p>
              ) : (
                <label className="flex items-start gap-2 rounded-lg border p-2">
                  <input
                    type="checkbox"
                    checked={info.folder.restricted}
                    disabled={!info.canManage}
                    onChange={(e) =>
                      void patch({ restricted: e.target.checked })
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">Restricted</span>
                    <span style={muted}>
                      {info.folder.restricted
                        ? "Only owners, admins and the people below see this folder and its projects. People invited to a project keep access to it."
                        : "Everyone in the workspace can see this folder."}
                      {!info.canManage &&
                        " Only owners and admins can change this."}
                    </span>
                  </span>
                </label>
              )}
              <ul className="divide-y rounded-lg border">
                {info.people.map((p) => {
                  const admin = p.role === "OWNER" || p.role === "ADMIN";
                  return (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">
                          {p.name ?? p.email}
                        </span>
                        <span style={muted}>
                          {p.role.toLowerCase()} ·{" "}
                          {p.canSee ? "can see" : "can't see"}
                        </span>
                      </span>
                      {info.canManage &&
                        ruledHere &&
                        info.folder.restricted &&
                        !admin && (
                          <button
                            onClick={() =>
                              void patch(
                                p.member
                                  ? { removeMember: p.id }
                                  : { addMember: p.id },
                              )
                            }
                            className="shrink-0 rounded-md border px-2 py-1"
                          >
                            {p.member ? "Remove" : "Add"}
                          </button>
                        )}
                    </li>
                  );
                })}
              </ul>
              {error && <p className="text-red-600">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
