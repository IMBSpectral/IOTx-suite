"use client";

import { useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./icons";

/**
 * The assistant's reply on the client, shared by AI Chat and the floating
 * assistant: the streamed request (one JSON event per line) and the reply
 * bubble with its live status line and actions.
 */

/** A long prompt from the start page waits here, not in the address (which caps its length). */
export const PENDING_ASK = "iotx-pending-ask";

export type Step = { kind: "sent" | "created" | "looked"; label: string; projectId?: string };
export type Msg = { id: string; role: "user" | "assistant"; content: string; steps?: Step[] | null; live?: boolean; status?: string | null };
export type SuiteAction = { kind: "fill"; tabId: string; text: string; field?: string; replace?: boolean } | { kind: "open"; url: string } | { kind: "reload"; match: string } | { kind: "shell" };

/** The live status line for a tool the assistant has just started. */
const ACTIVITY: Record<string, string> = {
  list_projects: "Looking through your projects…",
  project_details: "Reading a project…",
  create_project: "Creating a project…",
  send_to_project: "Sending work to a project…",
  search_company_knowledge: "Searching company knowledge…",
  suggest_knowledge_update: "Suggesting a knowledge update…",
  remember: "Saving to memory…",
  forget: "Updating memory…",
  web_search: "Searching the web…",
  web_fetch: "Reading a web page…",
  code_execution: "Sorting through the results…",
  list_open_tabs: "Looking at your tabs…",
  suite_spaces: "Looking at your dashboards and folders…",
  list_mail: "Checking your mail…",
  manage_space: "Updating your dashboards…",
  company_structure: "Looking at the company structure…",
  time_off: "Checking time off…",
  work_time: "Checking work time…",
  workspace_people: "Looking people up…",
  task_projects: "Looking at task projects…",
  task_search: "Searching tasks…",
  task_get: "Reading a task…",
  task_create: "Creating a task…",
  task_update: "Updating a task…",
  task_comment: "Commenting on a task…",
  calendar_events: "Checking the calendar…",
  calendar_create: "Adding an event…",
  calendar_update: "Changing an event…",
  calendar_delete: "Deleting an event…",
  chat_channels: "Looking at Chat…",
  chat_read: "Reading Chat…",
  chat_search: "Searching Chat…",
  chat_post: "Posting in Chat…",
  meeting_create: "Creating a meeting link…",
  meetings_search: "Searching meetings…",
  meeting_report: "Reading a meeting report…",
  meeting_action_items: "Checking action items…",
  read_mail: "Reading an email…",
  read_tab: "Reading a tab…",
  fill_tab: "Filling a tab…",
  open_in_suite: "Opening a page…",
  find_office_files: "Finding files in Google Drive…",
  create_office_file: "Creating a file…",
  read_sheet: "Reading the sheet…",
  write_sheet: "Writing to the sheet…",
  read_doc: "Reading the doc…",
  edit_doc: "Editing the doc…",
  read_slides: "Reading the deck…",
  edit_slides: "Editing the deck…",
};
export const activityLabel = (tool: string) => ACTIVITY[tool] ?? `Using ${tool.replace(/_/g, " ")}…`;

type Handlers = {
  onChat?: (chatId: string) => void;
  onUpdate: (patch: { content?: string; status?: string; steps?: Step[] }) => void;
  onAction?: (a: SuiteAction) => void;
};

/**
 * Sends a message and streams the reply. Resolves with the saved reply (or
 * an error message), calling the handlers as the reply takes shape.
 */
export async function askStream(body: Record<string, unknown>, h: Handlers): Promise<{ chatId: string | null; reply: Msg | null; error: string | null }> {
  const refs = typeof body.content === "string" ? await readRefs(body.content, (s) => h.onUpdate({ status: s })) : [];
  const res = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, refs, stream: true }) }).catch(() => null);
  if (!res?.ok || !res.body) {
    const d = await res?.json().catch(() => ({}));
    return { chatId: null, reply: null, error: d?.error ?? "Something went wrong. Try again." };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let chatId: string | null = null;
  let content = "";
  let thought = "";
  const steps: Step[] = [];
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "chat") {
        chatId = e.chatId as string;
        h.onChat?.(chatId);
      } else if (e.type === "thought") {
        thought = (thought + (e.delta as string)).slice(-2000);
        const last = thought.trim().split(/\n+/).pop()?.replace(/[*#`_]/g, "").trim();
        if (last) h.onUpdate({ status: `Thinking: ${last.length > 140 ? "…" + last.slice(-140) : last}` });
      } else if (e.type === "activity") {
        thought = "";
        h.onUpdate({ status: activityLabel(e.tool as string) });
      } else if (e.type === "text") {
        content += e.delta as string;
        h.onUpdate({ content, status: "Writing…" });
      } else if (e.type === "step") {
        steps.push(e.step as Step);
        h.onUpdate({ steps: [...steps] });
      } else if (e.type === "action") {
        h.onAction?.(e.action as SuiteAction);
      } else if (e.type === "done") {
        return { chatId: (e.chatId as string) ?? chatId, reply: e.reply as Msg, error: null };
      } else if (e.type === "error") {
        return { chatId, reply: null, error: (e.error as string) ?? "Something went wrong. Try again." };
      }
    }
  }
  return { chatId, reply: null, error: "The connection dropped before the reply finished. Try again." };
}

/**
 * The suite things a message refers to with @ ([@Name](link) from the global
 * picker): each one read as the person, so the AI gets what it says (a task, a
 * chat channel, a meeting's notes, a sheet…), not just its name.
 */
/** The referenced items' text, appended to a Builder message (and hidden from its chat bubble). */
export function refsBlock(refs: { title: string; url: string; text: string }[]) {
  if (!refs.length) return "";
  const attr = (s: string) => s.replace(/["<>\n]/g, " ");
  let budget = 60_000;
  const parts = refs.map((r) => {
    const body = r.text.slice(0, Math.max(0, budget));
    budget -= body.length;
    return `<ref title="${attr(r.title)}" link="${attr(r.url)}">\n${body}\n</ref>`;
  });
  return `\n\n<suite-refs>\nSuite items the user referenced with @, read as them:\n${parts.join("\n")}\n</suite-refs>`;
}

/** A message without the referenced items' text that refsBlock appended. */
export const withoutRefs = (s: string) => s.replace(/\n*<suite-refs>[\s\S]*<\/suite-refs>\s*$/, "");

export async function readRefs(text: string, status?: (s: string) => void) {
  const seen = new Set<string>();
  const out: { title: string; url: string; text: string }[] = [];
  const re = /\[@([^\]\n]{1,200})\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && seen.size < 6) {
    let path: string;
    try {
      const u = new URL(m[2], window.location.origin);
      if (u.origin !== window.location.origin) continue;
      path = u.pathname + u.search;
    } catch {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    status?.(`Reading ${m[1]}…`);
    const base = path.startsWith("/workspace/") ? "/workspace/api/mentions" : "/api/mentions";
    const d = await fetch(`${base}?ref=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (d?.text) out.push({ title: d.title ?? m[1], url: path, text: String(d.text).slice(0, 30_000) });
  }
  return out;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or a page without clipboard permission.
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  }
}

/** A small icon button for a reply's action bar. */
function Act({ icon, label, onClick, on }: { icon: string; label: string; onClick: () => void; on?: boolean }) {
  return (
    <button type="button" className="ix-act" title={label} aria-label={label} aria-pressed={on} onClick={onClick}>
      <Icon name={icon} size={14} />
    </button>
  );
}

/** The assistant's reply: live status while it's made, then markdown, steps and actions. */
export function AiReply({
  m,
  name,
  onRetry,
  onInsert,
  insertLabel = "Put into the tab you were in",
}: {
  m: Msg;
  name: string;
  onRetry?: () => void;
  onInsert?: (text: string) => void;
  insertLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  return (
    <div className="ix-bubble ai" style={{ position: "relative" }}>
      <b>{name}</b>
      {m.live && (
        <div className="ix-live" aria-live="polite">
          <span className="ix-live-dot" aria-hidden />
          {m.status ?? "Reading your message…"}
        </div>
      )}
      {!!m.content && (
        <div className="prose-chat" style={{ marginTop: 4 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
        </div>
      )}
      {!!m.steps?.length && (
        <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
          {m.steps.map((s, i) =>
            s.projectId ? (
              <Link key={i} href={`/projects/${s.projectId}`} className="ix-step">
                <i>✓</i>
                {s.label}
              </Link>
            ) : (
              <span key={i} className="ix-step">
                <i>✓</i>
                {s.label}
              </span>
            ),
          )}
        </div>
      )}
      {!m.live && !!m.content && (
        <div className="ix-acts" role="toolbar" aria-label="Reply actions">
          <Act
            icon={copied ? "check" : "copy"}
            label={copied ? "Copied" : "Copy"}
            onClick={() =>
              void copy(m.content).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          />
          {onInsert && <Act icon="insert" label={insertLabel} onClick={() => onInsert(m.content)} />}
          {onRetry && <Act icon="retry" label="Ask again" onClick={onRetry} />}
          <Act icon="thumbup" label="Good reply" on={vote === "up"} onClick={() => setVote(vote === "up" ? null : "up")} />
          <Act icon="thumbdown" label="Bad reply" on={vote === "down"} onClick={() => setVote(vote === "down" ? null : "down")} />
        </div>
      )}
    </div>
  );
}

/** A user's message with Copy and Edit. */
export function UserBubble({ m, onEdit }: { m: Msg; onEdit?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ix-bubble me ix-me-wrap" style={{ position: "relative" }}>
      {m.content}
      <div className="ix-acts ix-acts-me" role="toolbar" aria-label="Message actions">
        <Act
          icon={copied ? "check" : "copy"}
          label={copied ? "Copied" : "Copy"}
          onClick={() =>
            void copy(m.content).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        />
        {onEdit && <Act icon="edit" label="Edit and ask again" onClick={() => onEdit(m.content)} />}
      </div>
    </div>
  );
}
