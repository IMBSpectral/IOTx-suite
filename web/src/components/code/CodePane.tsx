"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, GitCompare, Lock, Wand2, WrapText } from "lucide-react";
import FileTree from "../FileTree";
import FileIcon from "./FileIcon";
import { useDarkTheme } from "./media";
import { canFormat } from "./format";

const CodeEditor = dynamic(() => import("./CodeEditor"), {
  ssr: false,
  loading: () => (
    <p className="p-4 text-xs" style={{ color: "var(--muted)" }}>
      Loading the editor…
    </p>
  ),
});

export type OpenFile = { path: string; content: string; rev: number; line?: number | null };

/** Files the editor shows but shouldn't change by hand: lockfiles and other generated output. */
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|.+\.min\.(js|css))$|(^|\/)(dist|node_modules)\//;

const WRAP_KEY = "forge:code-wrap";

/**
 * The Code tab, laid out like VS Code or Lovable's code view: the file tree
 * with file-type icons, a breadcrumb over the editor, and CodeMirror with
 * Format (Shift+Alt+F), soft wrap, and the last build's changes as an inline diff.
 */
export default function CodePane({
  projectId,
  files,
  openFile,
  draft,
  canEdit,
  building,
  saving,
  lastBuild,
  onOpen,
  onDraft,
  onSave,
}: {
  projectId: string;
  files: string[];
  openFile: OpenFile | null;
  draft: string | null;
  canEdit: boolean;
  building: boolean;
  saving: "idle" | "saving" | "saved" | "error";
  /** The latest finished build that wrote files: its version and the files it wrote. */
  lastBuild: { sha: string; paths: string[] } | null;
  onOpen: (path: string) => void;
  onDraft: (text: string) => void;
  onSave: () => void;
}) {
  const dark = useDarkTheme();
  const [wrap, setWrap] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(WRAP_KEY) === "on";
    } catch {
      return false;
    }
  });
  const [formatTick, setFormatTick] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [diffOn, setDiffOn] = useState(false);
  // The open file as it was before the last build: undefined while loading, null when the build created it.
  const [before, setBefore] = useState<{ key: string; content: string | null } | null>(null);

  const path = openFile?.path ?? null;
  const generated = !!path && GENERATED.test(path);
  const readOnly = !openFile || !canEdit || generated;
  const changed = !!path && !!lastBuild?.paths.includes(path);
  const diffKey = path && lastBuild ? `${lastBuild.sha}:${path}` : null;
  const showDiff = diffOn && changed && before?.key === diffKey;
  const dirty = draft !== null && draft !== openFile?.content;
  const sha = lastBuild?.sha ?? null;

  useEffect(() => {
    if (!diffOn || !changed || !diffKey || before?.key === diffKey || !sha || !path) return;
    let on = true;
    fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}&before=${sha}`)
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { content?: string | null; error?: string };
        if (!on) return;
        if (!r.ok) {
          setDiffOn(false);
          setNote(d.error ?? "Couldn't load the earlier version.");
          return;
        }
        setBefore({ key: diffKey, content: d.content ?? null });
      })
      .catch(() => on && setNote("Couldn't load the earlier version."));
    return () => {
      on = false;
    };
  }, [diffOn, changed, diffKey, before?.key, sha, path, projectId]);

  useEffect(() => {
    if (!note || note === "Formatting…") return;
    const t = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(t);
  }, [note]);

  function save() {
    if (building) return setNote("Wait for the agent to finish before saving.");
    if (readOnly || !dirty) return;
    onSave();
  }

  const crumbs = path ? path.split("/") : [];
  return (
    <div className="flex h-full">
      <div className="w-60 shrink-0 overflow-y-auto border-r">
        <FileTree files={files} active={path} onOpen={onOpen} changed={lastBuild?.paths} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <nav aria-label="File path" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[12px]">
            {path ? (
              crumbs.map((c, i) => (
                <span key={i} className="flex min-w-0 shrink items-center gap-0.5">
                  {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" style={{ color: "var(--muted)" }} aria-hidden />}
                  {i === crumbs.length - 1 ? (
                    <span className="flex min-w-0 items-center gap-1 font-medium" aria-current="page">
                      <FileIcon path={path} />
                      <span className="truncate">{c}</span>
                    </span>
                  ) : (
                    <span className="truncate" style={{ color: "var(--muted)" }}>{c}</span>
                  )}
                </span>
              ))
            ) : (
              <span style={{ color: "var(--muted)" }}>Select a file</span>
            )}
            {dirty && <span className="ml-1.5 shrink-0 text-[11px]" style={{ color: "var(--muted)" }}>· edited</span>}
            {openFile && readOnly && (
              <span className="ml-1.5 flex shrink-0 items-center gap-1 text-[11px]" style={{ color: "var(--muted)" }} title={generated ? "Generated file: change it through the agent" : "You can view this code but not edit it"}>
                <Lock className="h-3 w-3" /> Read only
              </span>
            )}
          </nav>
          {openFile && (
            <span className="flex shrink-0 items-center gap-1.5">
              {note && <span className="max-w-[260px] truncate text-[11px]" style={{ color: "var(--muted)" }} title={note}>{note}</span>}
              {saving === "saved" && !note && <span className="text-[11px] text-emerald-600">Saved to the draft</span>}
              {saving === "error" && !note && <span className="text-[11px] text-red-600">Could not save</span>}
              {changed && (
                <ToolButton label={diffOn ? "Hide the last build's changes" : "Show what the last build changed"} pressed={diffOn} onClick={() => setDiffOn((d) => !d)}>
                  <GitCompare className="h-3.5 w-3.5" /> Changes
                </ToolButton>
              )}
              <ToolButton
                label={wrap ? "Turn off soft wrap" : "Soft wrap long lines"}
                pressed={wrap}
                onClick={() => {
                  setWrap((w) => {
                    try {
                      localStorage.setItem(WRAP_KEY, w ? "off" : "on");
                    } catch {}
                    return !w;
                  });
                }}
              >
                <WrapText className="h-3.5 w-3.5" /> Wrap
              </ToolButton>
              <ToolButton
                label={canFormat(openFile.path) ? "Format document (Shift+Alt+F)" : "Prettier doesn't format this file type"}
                disabled={readOnly || !canFormat(openFile.path)}
                onClick={() => setFormatTick((t) => t + 1)}
              >
                <Wand2 className="h-3.5 w-3.5" /> Format
              </ToolButton>
              {!readOnly && (
                <button
                  onClick={save}
                  disabled={!dirty || saving === "saving" || building}
                  title={building ? "Wait for the agent to finish" : "Save this file (Ctrl+S)"}
                  className="rounded-md bg-[#6d4aff] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  {saving === "saving" ? "Saving…" : "Save"}
                </button>
              )}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {openFile ? (
            <CodeEditor
              key={`${openFile.path}:${openFile.rev}`}
              path={openFile.path}
              initial={draft ?? openFile.content}
              line={openFile.line}
              readOnly={readOnly}
              wrap={wrap}
              dark={dark}
              original={showDiff ? before!.content : undefined}
              formatTick={formatTick}
              onChange={onDraft}
              onSave={save}
              onFormatStatus={setNote}
            />
          ) : (
            <p className="p-4 text-xs" style={{ color: "var(--muted)" }}>
              Pick a file on the left to see its code.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolButton({ label, pressed, disabled, onClick, children }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] disabled:opacity-40 ${pressed ? "bg-black/[.07] dark:bg-white/[.1]" : "hover:bg-black/[.04] dark:hover:bg-white/[.06]"}`}
      style={{ color: pressed ? "var(--text)" : "var(--muted)" }}
    >
      {children}
    </button>
  );
}
