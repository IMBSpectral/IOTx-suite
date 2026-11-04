"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import FileIcon from "./code/FileIcon";

type Node = { name: string; path: string; children?: Node[] };

/** Turn flat paths into folders-first, alphabetical nodes. */
function build(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const p of paths) {
    let at = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        at.children!.push({ name: part, path });
        return;
      }
      let next = at.children!.find((c) => c.children && c.name === part);
      if (!next) {
        next = { name: part, path, children: [] };
        at.children!.push(next);
      }
      at = next;
    });
  }
  const sort = (nodes: Node[]): Node[] =>
    nodes
      .sort((a, b) => (!!b.children === !!a.children ? a.name.localeCompare(b.name) : a.children ? -1 : 1))
      .map((n) => (n.children ? { ...n, children: sort(n.children) } : n));
  return sort(root.children!);
}

/** The project's files as a collapsible tree with file-type icons, like Lovable's code view. */
export default function FileTree({
  files,
  active,
  onOpen,
  changed,
}: {
  files: string[];
  active: string | null;
  onOpen: (path: string) => void;
  /** Files the last build changed, marked with a dot. */
  changed?: string[];
}) {
  const tree = useMemo(() => build(files), [files]);
  const touched = useMemo(() => new Set(changed ?? []), [changed]);
  // src/ starts open; everything else opens on click or when it holds the open file.
  const [open, setOpen] = useState<Set<string>>(() => new Set(["src"]));
  const isOpen = (p: string) => open.has(p) || (!!active && active.startsWith(`${p}/`));

  function render(nodes: Node[], depth: number): React.ReactNode {
    return nodes.map((n) =>
      n.children ? (
        <li key={n.path}>
          <button
            onClick={() =>
              setOpen((s) => {
                const next = new Set(s);
                if (isOpen(n.path)) next.delete(n.path);
                else next.add(n.path);
                return next;
              })
            }
            aria-expanded={isOpen(n.path)}
            className="flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-[13px] hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            style={{ paddingLeft: 6 + depth * 12 }}
          >
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${isOpen(n.path) ? "rotate-90" : ""}`} style={{ color: "var(--muted)" }} />
            {isOpen(n.path) ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: "#8b8b96" }} />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: "#8b8b96" }} />
            )}
            <span className="truncate">{n.name}</span>
          </button>
          {isOpen(n.path) && <ul>{render(n.children, depth + 1)}</ul>}
        </li>
      ) : (
        <li key={n.path}>
          <button
            onClick={() => onOpen(n.path)}
            aria-current={active === n.path ? "true" : undefined}
            title={n.path}
            className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] ${
              active === n.path ? "bg-black/[.07] font-medium dark:bg-white/[.1]" : "hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            }`}
            style={{ paddingLeft: 24 + depth * 12 }}
          >
            <FileIcon path={n.path} />
            <span className="truncate">{n.name}</span>
            {touched.has(n.path) && (
              <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="Changed in the last build" aria-label="Changed in the last build" />
            )}
          </button>
        </li>
      ),
    );
  }

  if (!files.length) {
    return (
      <p className="p-3 text-xs" style={{ color: "var(--muted)" }}>
        No files yet.
      </p>
    );
  }
  return <ul className="p-1.5" aria-label="Project files">{render(tree, 0)}</ul>;
}
