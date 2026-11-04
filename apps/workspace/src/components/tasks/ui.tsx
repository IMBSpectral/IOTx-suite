"use client";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, Bug, CheckSquare, ChevronsDown, ChevronsUp, ChevronUp, Equal, GitBranch, Layers, Zap } from "lucide-react";
import { colorFor, initials, suiteAt } from "@/lib/client";

// ── Shapes from the API ────────────────────────────────────────────────────

export type Status = { id: string; name: string; category: "todo" | "doing" | "done"; color: string; wip: number | null; min?: number | null };
export type Project = {
  id: string; key: string; name: string; description: string; color: string; leadId: string | null; createdBy: string; archived: boolean;
  statuses: Status[]; labelDefs: { name: string; color: string }[]; members: { userId: string; role: string }[]; memberIds: string[];
  fieldDefs: FieldDef[]; templates: Template[];
  quickFilters: { id: string; name: string; query: string }[];
  features: { sprints: boolean; releases: boolean; components: boolean; estimation: "points" | "time" };
  myRole: string; open: number; activeSprint: { id: string; name: string; endAt: string | null } | null;
};
export type Task = {
  id: string; key: string; number: number; projectId: string; type: string; parentId: string | null; epicId: string | null; sprintId: string | null;
  title: string; description: string; status: string; done: boolean; priority: number; assigneeId: string | null; watchers: string[];
  start: string | null; due: string | null; overdue: boolean; points: number | null; estimateMin: number | null; loggedMin: number;
  labels: string[]; custom: Record<string, string | number | boolean>;
  flagged: boolean; flagNote: string | null; versionId: string | null; componentIds: string[]; statusAt: string; blocks: string[]; coverId: string | null; checklist: { text: string; done: boolean }[]; links: { url: string; title: string }[]; position: number; createdBy: string;
  messageId: string | null; completedAt: string | null; createdAt: string; updatedAt: string; comments: number; attachments: number; issueLinks: number;
  subtasks: { total: number; done: number };
};
export type Sprint = { id: string; projectId: string; name: string; goal: string; state: "planned" | "active" | "closed"; startAt: string | null; endAt: string | null; completedAt: string | null; createdAt?: string; stats: any };
export type Person = { id: string; name: string; email: string; image: string | null };
export type Version = { id: string; name: string; description: string; startDate: string | null; releaseDate: string | null; status: "unreleased" | "released" | "archived"; releasedAt: string | null; issues: number; done: number; doing: number };
export type Component = { id: string; name: string; description: string; leadId: string | null; issues: number };
export type FieldDef = { id: string; name: string; type: "text" | "number" | "select" | "date" | "user" | "checkbox"; options?: string[] };
export type Template = { id: string; name: string; type: string; title: string; description: string; labels: string[]; priority: number };

// ── Types and priorities ───────────────────────────────────────────────────

export const TYPES: { id: string; label: string; color: string; Icon: typeof Bug }[] = [
  { id: "task", label: "Task", color: "#2563eb", Icon: CheckSquare },
  { id: "story", label: "Story", color: "#16a34a", Icon: Bookmark },
  { id: "bug", label: "Bug", color: "#dc2626", Icon: Bug },
  { id: "epic", label: "Epic", color: "#7c3aed", Icon: Zap },
  { id: "subtask", label: "Subtask", color: "#0891b2", Icon: GitBranch },
];
export const typeOf = (id: string) => TYPES.find((t) => t.id === id) ?? TYPES[0];
export const PRIORITIES = [
  { id: 0, label: "Low", color: "#64748b", Icon: ChevronsDown },
  { id: 1, label: "Normal", color: "#2563eb", Icon: Equal },
  { id: 2, label: "High", color: "#ea580c", Icon: ChevronUp },
  { id: 3, label: "Urgent", color: "#dc2626", Icon: ChevronsUp },
];

export function TypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  const t = typeOf(type);
  return (
    <span className="tk-type" style={{ background: t.color, width: size, height: size }} title={t.label} aria-label={t.label}>
      <t.Icon size={size - 5} strokeWidth={2.6} />
    </span>
  );
}
export function PriorityIcon({ p, size = 15 }: { p: number; size?: number }) {
  const x = PRIORITIES[p] ?? PRIORITIES[1];
  return <x.Icon size={size} color={x.color} strokeWidth={2.6} aria-label={`${x.label} priority`} />;
}
export function EpicIcon() {
  return <Layers size={12} />;
}

export function Avatar({ person, size = 24, title }: { person?: Person | null; size?: number; title?: string }) {
  if (!person)
    return (
      <span className="tk-av empty" style={{ width: size, height: size }} title={title ?? "Unassigned"} aria-label={title ?? "Unassigned"}>
        ?
      </span>
    );
  return person.image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="tk-av" src={person.image} alt="" title={title ?? person.name} style={{ width: size, height: size }} />
  ) : (
    <span className="tk-av" style={{ width: size, height: size, background: colorFor(person.id), fontSize: size * 0.42 }} title={title ?? person.name}>
      {initials(person.name)}
    </span>
  );
}

export function StatusPill({ s }: { s?: Status }) {
  if (!s) return null;
  return (
    <span className={`tk-status cat-${s.category}`} style={{ ["--st" as string]: s.color }}>
      {s.name}
    </span>
  );
}

export function fmtDay(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, day);
  const t = new Date();
  const diff = Math.round((dt.getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return dt.toLocaleDateString([], { month: "short", day: "numeric", ...(dt.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}) });
}
export const fmtMin = (m: number | null | undefined) => {
  if (!m) return "0m";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h}h${r ? ` ${r}m` : ""}` : `${r}m`;
};
export const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
};

export function labelColor(name: string, defs: { name: string; color: string }[]) {
  return defs.find((d) => d.name.toLowerCase() === name.toLowerCase())?.color ?? colorFor(name);
}

// ── A small dropdown menu (click to open, Esc or outside click to close) ───

export function Menu({ button, children, align = "left", label }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div className="tk-menu" ref={ref}>
      <span onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={label} role="button" tabIndex={-1} style={{ display: "contents" }}>
        {button(open)}
      </span>
      {open && (
        <div className={`tk-menu-pop ${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ── Markdown (safe subset: headings, bold, italic, code, links, lists, quotes, checkboxes) ──

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(_[^_]+_|\*[^*]+\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)|(@[\w.-]+(?: [A-Z][\w-]+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer">{m[4].slice(1, m[4].indexOf("]"))}</a>);
    else if (m[6]) out.push(<a key={k} href={m[6]} target="_blank" rel="noreferrer">{m[6]}</a>);
    else if (m[7]) out.push(<span key={k} className="tk-mention">{m[7]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, empty }: { text: string; empty?: ReactNode }) {
  if (!text.trim()) return <>{empty ?? null}</>;
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const ln = lines[i];
    if (ln.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={i}><code>{code.join("\n")}</code></pre>);
    } else if (/^#{1,3} /.test(ln)) {
      const lvl = ln.match(/^#+/)![0].length;
      const H = (["h3", "h4", "h5"] as const)[lvl - 1];
      blocks.push(<H key={i}>{inline(ln.replace(/^#+ /, ""), `h${i}`)}</H>);
      i++;
    } else if (/^\s*([-*]|\d+\.) /.test(ln)) {
      const ordered = /^\s*\d+\. /.test(ln);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.) /, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(
        <L key={i}>
          {items.map((it, j) => {
            const box = /^\[( |x)\] /i.exec(it);
            return <li key={j} className={box ? "check" : undefined}>{box ? <><input type="checkbox" checked={box[1] !== " "} readOnly /> {inline(it.slice(4), `l${i}-${j}`)}</> : inline(it, `l${i}-${j}`)}</li>;
          })}
        </L>,
      );
    } else if (ln.startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) q.push(lines[i++].slice(2));
      blocks.push(<blockquote key={i}>{inline(q.join(" "), `q${i}`)}</blockquote>);
    } else if (!ln.trim()) i++;
    else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,3} |\s*([-*]|\d+\.) |> )/.test(lines[i])) para.push(lines[i++]);
      blocks.push(<p key={i}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `p${i}-${j}`)}</Fragment>)}</p>);
    }
  }
  return <div className="tk-md">{blocks}</div>;
}

/** A textarea with @mention suggestions from the given people. */
export function MentionBox({ value, onChange, people, placeholder, rows = 3, onSubmit, autoFocus, id }: { value: string; onChange: (v: string) => void; people: Person[]; placeholder?: string; rows?: number; onSubmit?: () => void; autoFocus?: boolean; id?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [hi, setHi] = useState(0);
  const caret = ref.current?.selectionStart ?? value.length;
  const m = suiteAt() ? null : /(^|\s)@([\w.-]*)$/.exec(value.slice(0, caret));
  const matches = m ? people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(m[2].toLowerCase())).slice(0, 6) : [];
  const pick = (p: Person) => {
    const start = caret - m![2].length - 1;
    onChange(`${value.slice(0, start)}@${p.name} ${value.slice(caret)}`);
    setHi(0);
    requestAnimationFrame(() => ref.current?.focus());
  };
  return (
    <div className="tk-mentionbox">
      <textarea
        id={id}
        ref={ref}
        className="ws-textarea"
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % matches.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + matches.length) % matches.length); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[hi]); return; }
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && onSubmit) { e.preventDefault(); onSubmit(); }
        }}
      />
      {matches.length > 0 && (
        <ul className="tk-mention-pop" role="listbox">
          {matches.map((p, i) => (
            <li key={p.id}>
              <button type="button" role="option" aria-selected={i === hi} className={i === hi ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
                <Avatar person={p} size={20} /> {p.name} <span className="ws-muted">{p.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
