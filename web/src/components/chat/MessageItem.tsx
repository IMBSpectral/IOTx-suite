"use client";

import { useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import type { Brand } from "@/lib/brand-shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { defaultUrlTransform } from "react-markdown";
import { linkMentions } from "@/lib/composer-format";

/** What the person sent: their Markdown formatting, line breaks as typed, @mentions as chips. */
function UserText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => (url.startsWith("mention:") ? url : defaultUrlTransform(url))}
      components={{
        a: ({ href, children }) =>
          href?.startsWith("mention:") ? (
            <span data-chip="mention" className="rounded px-1 font-medium" style={{ background: "color-mix(in srgb, var(--accent) 16%, transparent)" }}>
              {children}
            </span>
          ) : (
            <a href={href} target="_blank" rel="noreferrer" className="underline">
              {children}
            </a>
          ),
      }}
    >
      {linkMentions(text)}
    </ReactMarkdown>
  );
}
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  Brain,
  Check,
  Copy,
  FileText,
  Link2,
  ListChecks,
  Hammer,
  Database,
  FolderPlus,
  KeyRound,
  Megaphone,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  ScrollText,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Shapes,
  PauseCircle,
  Wand2,
} from "lucide-react";
import QuestionsCard from "./QuestionsCard";
import CloudCards from "./CloudCards";
import { useAccountPrefs } from "../useAccountPrefs";
import { CreditRequestCard, PermissionCard, SkillProposalCard, VaultCard } from "./AgentRequestCards";
import ChangesetCards from "./ChangesetCards";
import VisualCards from "./VisualCards";
import DocumentCards from "./DocumentCards";
import CreditPauseCard from "./CreditPauseCard";
import GeneratedImages from "./GeneratedImages";
import ToolCalls from "./ToolCalls";
import ThinkingBlock from "./ThinkingBlock";
import PlanChanges from "./PlanChanges";
import BuildLog from "./BuildLog";
import ProjectThumb from "../ProjectThumb";
import AttachmentView from "./AttachmentView";
import FileCards, { type LiveFile } from "./FileCards";
import { formatDuration, parseStep, type Msg, type Step } from "./types";
import { withoutRefs } from "../iotx/ai";

const ICON = "h-3.5 w-3.5";

/** Looks like a project file path: src/x/y.tsx, index.html, ./vite.config.ts */
const PATH = /^(\.\/)?([\w@.-]+\/)*[\w@-][\w@.-]*\.(tsx?|jsx?|css|html|json|md|svg|png|jpe?g|webp|sql|mjs|cjs)$/;

const LOG_KINDS = new Set(["all", "errors", "console", "network"]);

function describe(step: Exclude<Step, { kind: "questions" }>, brand: Brand): [React.ReactNode, React.ReactNode] {
  switch (step.kind) {
    case "write":
      return [<Pencil key="i" className={ICON} />, <>Edited <code>{step.path}</code></>];
    case "delete":
      return [<Trash2 key="i" className={ICON} />, <>Deleted <code>{step.path}</code></>];
    case "read":
      return [<FileText key="i" className={ICON} />, <>Read <code>{step.path}</code></>];
    case "paused":
      return [<PauseCircle key="i" className={ICON} />, <>Paused: out of credits</>];
    case "logs":
      // "logs:" carries both log reads (a kind) and plain activity notes ("Ran npm test", "Recalled memory").
      return [
        <ScrollText key="i" className={ICON} />,
        LOG_KINDS.has(step.detail) ? <>Read preview logs ({step.detail})</> : <>{step.detail}</>,
      ];
    case "memory":
      return [<Brain key="i" className={ICON} />, <>Remembered: {step.detail}</>];
    case "tasks":
      return [<ListChecks key="i" className={ICON} />, <>Updated tasks ({step.detail} done)</>];
    case "cloud":
      return [<Database key="i" className={ICON} />, step.auto ? <>Turned on {brand.shortName} Cloud</> : <>Asked to enable {brand.shortName} Cloud</>];
    case "migration":
      return [<Database key="i" className={ICON} />, <>Proposed a migration: {step.detail}</>];
    case "secret":
      return [<KeyRound key="i" className={ICON} />, <>Asked for secret {step.name}</>];
    case "switch":
      return [<Hammer key="i" className={ICON} />, <>Asked to switch to Build</>];
    case "credits":
      return [<PauseCircle key="i" className={ICON} />, step.ask === "limit" ? <>Asked to raise the credit limit</> : <>Asked for more credits</>];
    case "skill":
      return [<Wand2 key="i" className={ICON} />, <>Proposed the skill /{step.name}</>];
    case "vault":
      return [<KeyRound key="i" className={ICON} />, <>Asked for a saved login for {step.site}</>];
    case "permission":
      return [<KeyRound key="i" className={ICON} />, <>Asked to use {step.connection}: {step.tool}</>];
    case "project":
      return [<FolderPlus key="i" className={ICON} />, <>Created the project {step.detail}</>];
    case "moved":
      return [<FolderPlus key="i" className={ICON} />, <>Moved the work to {step.detail}</>];
    case "document":
      return [<ScrollText key="i" className={ICON} />, <>Wrote a document</>];
    case "visual":
      return [<Shapes key="i" className={ICON} />, <>Created a visual explanation</>];
    case "changeset":
      return [<Megaphone key="i" className={ICON} />, <>Proposed ad changes: {step.detail}</>];
    case "report":
      return [<ListChecks key="i" className={ICON} />, <>Turn report</>];
    case "thinking":
      return [<ListChecks key="i" className={ICON} />, <>Thought</>];
    case "call":
      return [<ListChecks key="i" className={ICON} />, <>{step.tool}</>];
  }
}

function StepRow({ step, onOpenPath }: { step: Step; onOpenPath: (p: string) => void }) {
  const brand = useBrand();
  if (step.kind === "questions") return null;
  const [icon, label] = describe(step, brand);
  const path = step.kind === "write" || step.kind === "read" ? step.path : null;
  return (
    <li className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
      {icon}
      {path ? (
        <button onClick={() => onOpenPath(path)} className="truncate text-left hover:underline">
          {label}
        </button>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </li>
  );
}

/** Tool activity, collapsed into a summary once there is more than a glance. */
function Activity({ steps, onOpenPath }: { steps: Step[]; onOpenPath: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  // Written files are shown as file cards (FileCards) instead.
  const visible = steps.filter((s) => s.kind !== "questions" && s.kind !== "call" && s.kind !== "thinking" && s.kind !== "write");
  if (visible.length === 0) return null;
  const edits = visible.filter((s) => s.kind === "write" || s.kind === "delete").length;
  const reads = visible.length - edits;
  if (visible.length <= 4 || open) {
    return (
      <ul className="mt-2 space-y-0.5">
        {visible.map((s, i) => (
          <StepRow key={i} step={s} onOpenPath={onOpenPath} />
        ))}
        {open && (
          <li>
            <button onClick={() => setOpen(false)} className="text-[11px] hover:underline" style={{ color: "var(--muted)" }}>
              Show less
            </button>
          </li>
        )}
      </ul>
    );
  }
  return (
    <button
      onClick={() => setOpen(true)}
      className="mt-2 rounded-lg border px-2 py-1 text-[11px] hover:bg-black/[.04] dark:hover:bg-white/[.06]"
      style={{ color: "var(--muted)" }}
    >
      {edits > 0 ? `${edits} file${edits === 1 ? "" : "s"} changed` : ""}
      {edits > 0 && reads > 0 ? " · " : ""}
      {reads > 0 ? `${reads} step${reads === 1 ? "" : "s"} explored` : ""}
    </button>
  );
}

function Action({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded-md p-1 transition-colors hover:bg-black/[.05] dark:hover:bg-white/[.08] ${
        active ? "text-[#6d4aff]" : ""
      }`}
      style={active ? undefined : { color: "var(--muted)" }}
    >
      {children}
    </button>
  );
}

export type MessageActions = {
  onOpenPath: (path: string) => void;
  onFeedback: (msg: Msg, value: "up" | "down") => void;
  onUndo: (msg: Msg, action: "undo" | "redo") => void;
  onBookmark: (msg: Msg) => void;
  onRerun: (msg: Msg) => void;
  onAnswer: (text: string) => void;
  onApprovePlan: (plan: string) => void;
  /** Ask for a revised plan (Plan mode, composer prefilled). */
  onRevisePlan?: () => void;
  onSwitchToBuild: (change: string) => void;
  onRunNow: (buildId: string) => void;
  onRemove: (buildId: string) => void;
  /** Move a queued message earlier (-1) or later (1) in the queue. */
  onMove?: (buildId: string, by: -1 | 1) => void;
  onEditQueued: (buildId: string, content: string) => void;
};

export default function MessageItem({
  msg,
  projectId,
  stage,
  latestWithChanges,
  isLast,
  firstGeneration = false,
  queuedBuildId,
  actions,
  files,
  plan,
  live = null,
  canViewCode = true,
}: {
  /** The file this turn is writing right now, streamed (only on the running turn). */
  live?: LiveFile | null;
  /** Whether the person may see the code (file cards expand to show it). */
  canViewCode?: boolean;
  /** For a plan reply: its version in this chat and the previous version's text. */
  plan?: { version: number; previous: string | null };
  /** The project's files, so paths in replies can link to the code. */
  files?: string[];
  msg: Msg;
  projectId: string;
  /** Live stage text while this turn runs. */
  stage: string | null;
  /** Whether this is the newest turn that changed files (undo applies only to it). */
  latestWithChanges: boolean;
  isLast: boolean;
  /** The chat's first agent reply (for "suggestions on first generation only"). */
  firstGeneration?: boolean;
  /** For a user message whose reply is still queued. */
  queuedBuildId?: string;
  actions: MessageActions;
}) {
  const prefs = useAccountPrefs();
  const [copied, setCopied] = useState<"text" | "link" | null>(null);
  const brand = useBrand();
  const [logOpen, setLogOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(withoutRefs(msg.content));

  const steps = msg.files.map(parseStep).filter((s): s is Step => !!s);
  const questions = steps.find((s) => s.kind === "questions");
  const switchStep = steps.find((s) => s.kind === "switch");
  const report = steps.find((s) => s.kind === "report");

  async function copy(kind: "text" | "link") {
    const value =
      kind === "text" ? withoutRefs(msg.content) : `${location.origin}${location.pathname}#m-${msg.id}`;
    await navigator.clipboard.writeText(value).catch(() => undefined);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  if (msg.role === "user") {
    return (
      <div id={`m-${msg.id}`}>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            You
            {msg.mode === "goal" && <span className="ml-1.5 normal-case tracking-normal">· Sent in Goal mode</span>}
            {(msg.mode as string) === "goal_run" && <span className="ml-1.5 normal-case tracking-normal">· Sent during goal run</span>}
            {(msg.mode as string) === "automation" && <span className="ml-1.5 normal-case tracking-normal">· Sent from Automation</span>}
            {(msg.mode as string) === "assistant" && <span className="ml-1.5 normal-case tracking-normal">· Sent from Assistant</span>}
            {(msg.mode as string) === "api" && <span className="ml-1.5 normal-case tracking-normal">· Sent from MCP</span>}
          </p>
          {queuedBuildId && (
            <span className="rounded-full border px-1.5 text-[10px]" style={{ color: "var(--muted)" }}>
              Queued
            </span>
          )}
        </div>
        {editing && queuedBuildId ? (
          <div className="rounded-xl border p-2" style={{ background: "var(--panel)" }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              aria-label="Edit queued message"
              className="w-full resize-none bg-transparent text-sm outline-none"
            />
            <div className="flex justify-end gap-1.5">
              <button onClick={() => setEditing(false)} className="rounded-md px-2 py-0.5 text-xs" style={{ color: "var(--muted)" }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  actions.onEditQueued(queuedBuildId, draft);
                  setEditing(false);
                }}
                className="rounded-md bg-[#6d4aff] px-2 py-0.5 text-xs text-white"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="prose-chat rounded-xl border px-3 py-2 text-sm" style={{ background: "var(--panel)" }} data-user-message>
            <UserText text={withoutRefs(msg.content)} />
          </div>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {msg.attachments.map((a) => (
              <AttachmentView key={a.id} a={a} src={`/api/projects/${projectId}/uploads/${a.id}`} />
            ))}
          </div>
        )}
        <div className="mt-1 flex items-center gap-0.5">
          <Action label={copied === "text" ? "Copied" : "Copy"} onClick={() => copy("text")}>
            {copied === "text" ? <Check className={ICON} /> : <Copy className={ICON} />}
          </Action>
          {queuedBuildId && (
            <>
              <Action label="Run now (interrupts the current turn)" onClick={() => actions.onRunNow(queuedBuildId)}>
                <Play className={ICON} />
              </Action>
              <Action label="Edit queued message" onClick={() => setEditing(true)}>
                <Pencil className={ICON} />
              </Action>
              <Action label="Remove from queue" onClick={() => actions.onRemove(queuedBuildId)}>
                <Trash2 className={ICON} />
              </Action>
              {actions.onMove && (
                <>
                  <Action label="Move earlier in the queue" onClick={() => actions.onMove!(queuedBuildId, -1)}>
                    <ArrowUp className={ICON} />
                  </Action>
                  <Action label="Move later in the queue" onClick={() => actions.onMove!(queuedBuildId, 1)}>
                    <ArrowDown className={ICON} />
                  </Action>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const running = msg.status === "running" || msg.status === "queued";
  const isPlan = msg.mode === "plan" && msg.status === "done" && msg.content.trim();

  return (
    <div id={`m-${msg.id}`}>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--muted)" }}>
        {brand.shortName}{msg.mode && msg.mode !== "build" ? ` · ${(msg.mode as string) === "goal_run" ? "goal" : msg.mode}` : ""}
      </p>
      <ThinkingBlock steps={steps} />
      {msg.content ? (
        <div className="prose-chat text-sm leading-relaxed" data-agent-message>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // `src/pages/Index.tsx` in a reply becomes a link to that file in the code view.
              code({ className, children, ...rest }) {
                const text = String(children);
                if (className || /\r?\n/.test(text) || !PATH.test(text)) {
                  return (
                    <code className={className} {...rest}>
                      {children}
                    </code>
                  );
                }
                const rel = text.replace(/^\.\//, "");
                const known = files?.includes(rel);
                return known ? (
                  <button onClick={() => actions.onOpenPath(rel)} className="font-mono text-[0.85em] underline decoration-dotted underline-offset-2" title="Open in the code view">
                    {text}
                  </button>
                ) : (
                  <code title={files ? "Not found in this project's files" : undefined}>{children}</code>
                );
              },
            }}
          >
            {msg.content}
          </ReactMarkdown>
        </div>
      ) : running ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {msg.status === "queued" ? "Waiting in the queue…" : (stage ?? "Working…")}
        </p>
      ) : null}

      <FileCards projectId={projectId} steps={msg.files} live={live} files={files} canView={canViewCode} onOpenPath={actions.onOpenPath} />
      <Activity steps={steps} onOpenPath={actions.onOpenPath} />

      {report?.kind === "report" && (
        <details className="mt-2 rounded-xl border px-3 py-2 text-xs" style={{ background: "var(--panel)" }}>
          {/* The version card: what this change was called, with the details folded away. */}
          <summary className="cursor-pointer font-medium">{report.title || "Turn report"}</summary>
          {report.changed.length > 0 && (
            <ul className="mt-1.5 list-disc pl-4">
              {report.changed.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {report.checked && (
            <p className="mt-1.5" style={{ color: "var(--muted)" }}>
              Checked: {report.checked}
            </p>
          )}
        </details>
      )}
      {/* Suggested next steps stay in view under the latest reply, one click to send. */}
      {isLast && report && report.next.length > 0 && (prefs?.suggestions ?? "all") !== "off" && (prefs?.suggestions !== "first" || firstGeneration) && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs" aria-label="Suggested next steps">
          {report.next.map((n, i) => (
            <button key={i} onClick={() => actions.onAnswer(n)} className="rounded-full border px-2.5 py-1 hover:bg-black/[.04] dark:hover:bg-white/[.06]">
              {n}
            </button>
          ))}
        </div>
      )}

      {isLast && steps.some((s) => s.kind === "paused") && <CreditPauseCard onSend={actions.onAnswer} />}
      {isLast && <CloudCards projectId={projectId} steps={steps} onContinue={actions.onAnswer} />}
      {isLast && <CreditRequestCard projectId={projectId} steps={steps} onContinue={actions.onAnswer} />}
      {isLast && <PermissionCard steps={steps} onContinue={actions.onAnswer} />}
      {isLast && <VaultCard steps={steps} />}
      <SkillProposalCard steps={steps} />
      <ChangesetCards projectId={projectId} steps={steps} />
      <VisualCards projectId={projectId} steps={steps} />
      <GeneratedImages projectId={projectId} steps={steps} />
      <DocumentCards steps={steps} />
      <ToolCalls steps={steps} projectId={projectId} canRestore />
      {steps
        .filter((s): s is Extract<Step, { kind: "project" | "moved" }> => s.kind === "project" || s.kind === "moved")
        .map((s) => (
          <a
            key={s.id}
            href={`/projects/${s.id}`}
            className="mt-3 flex items-center gap-3 rounded-xl border p-2 pr-3 text-xs transition-colors hover:bg-black/[.03]"
            style={{ background: "var(--panel)" }}
            aria-label={`Open ${s.detail}`}
          >
            <span className="w-24 shrink-0">
              <ProjectThumb id={s.id} name={s.detail} emoji={null} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.detail}</span>
              <span style={{ color: "var(--muted)" }}>{s.kind === "moved" ? "Its agent is working on your request" : "New project · building now"}</span>
            </span>
            <span className="shrink-0 rounded-lg border px-2.5 py-1 font-medium">{s.kind === "moved" ? "Continue there" : "Open"}</span>
          </a>
        ))}

      {isLast && switchStep?.kind === "switch" && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border p-2.5" style={{ background: "var(--panel)" }}>
          <p className="flex-1 text-xs">
            The agent needs Build mode to make this change
            {switchStep.detail ? <span style={{ color: "var(--muted)" }}>: {switchStep.detail}</span> : "."}
          </p>
          <button
            onClick={() => actions.onSwitchToBuild(switchStep.detail)}
            className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
            style={{ background: "var(--accent)" }}
          >
            Switch to Build
          </button>
        </div>
      )}

      {questions?.kind === "questions" && isLast && (
        <>
          <QuestionsCard questions={questions.questions} onSubmit={actions.onAnswer} />
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }} role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden /> Waiting for your answer
          </p>
        </>
      )}

      {isPlan && plan && plan.previous && <PlanChanges previous={plan.previous} current={msg.content} version={plan.version} />}

      {isPlan && isLast && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border p-2.5" style={{ background: "var(--panel)" }}>
          <p className="flex-1 text-xs">{plan && plan.version > 1 ? `Plan v${plan.version} is ready.` : "Your plan is ready."} Ready to build?</p>
          {actions.onRevisePlan && (
            <button
              onClick={() => actions.onRevisePlan!()}
              className="rounded-md border px-2.5 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            >
              Revise plan
            </button>
          )}
          <button
            onClick={() => actions.onApprovePlan(msg.content)}
            className="rounded-md bg-[#6d4aff] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
          >
            Approve and build
          </button>
        </div>
      )}

      {msg.status === "failed" && (
        <div className="mt-2">
          <button
            onClick={() => actions.onRerun(msg)}
            className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-black/[.04] dark:hover:bg-white/[.06]"
          >
            Rerun build
          </button>
        </div>
      )}

      {!running && msg.status && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <div className="flex items-center gap-0.5">
            <Action label={copied === "text" ? "Copied" : "Copy"} onClick={() => copy("text")}>
              {copied === "text" ? <Check className={ICON} /> : <Copy className={ICON} />}
            </Action>
            <Action label={copied === "link" ? "Link copied" : "Copy link to message"} onClick={() => copy("link")}>
              {copied === "link" ? <Check className={ICON} /> : <Link2 className={ICON} />}
            </Action>
            <Action label="Helpful" active={msg.feedback === "up"} onClick={() => actions.onFeedback(msg, "up")}>
              <ThumbsUp className={ICON} />
            </Action>
            <Action label="Not helpful" active={msg.feedback === "down"} onClick={() => actions.onFeedback(msg, "down")}>
              <ThumbsDown className={ICON} />
            </Action>
            {msg.buildId && (
              <Action label="View build log" onClick={() => setLogOpen(true)}>
                <ScrollText className={ICON} />
              </Action>
            )}
            {logOpen && msg.buildId && <BuildLog buildId={msg.buildId} onClose={() => setLogOpen(false)} />}
            {msg.sha && (
              <Action label="Bookmark in history" onClick={() => actions.onBookmark(msg)}>
                <Bookmark className={ICON} />
              </Action>
            )}
            {msg.sha && msg.undone && (
              <Action label="Reapply this edit" onClick={() => actions.onUndo(msg, "redo")}>
                <RotateCw className={ICON} />
              </Action>
            )}
            {msg.sha && !msg.undone && latestWithChanges && (
              <Action label="Undo latest edit" onClick={() => actions.onUndo(msg, "undo")}>
                <RotateCcw className={ICON} />
              </Action>
            )}
          </div>
          {msg.status === "stopped" && isLast && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs" role="status">
              <span className="min-w-0 flex-1">
                You stopped this turn partway{msg.sha ? ", so some changes may be unfinished" : ""}. Continue to finish it
                {msg.sha && !msg.undone && latestWithChanges ? ", or revert this turn" : ""}.
              </span>
              <button onClick={() => actions.onAnswer("continue")} className="btn-primary rounded-md px-2.5 py-1">
                Continue
              </button>
              {msg.sha && !msg.undone && latestWithChanges && (
                <button onClick={() => actions.onUndo(msg, "undo")} className="rounded-md border px-2.5 py-1 hover:bg-black/[.04] dark:hover:bg-white/[.06]">
                  Revert this turn
                </button>
              )}
            </div>
          )}
          {(msg.durationMs || msg.credits) ? (
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
              {msg.durationMs ? `Worked for ${formatDuration(msg.durationMs)}` : ""}
              {msg.durationMs && msg.credits ? " · " : ""}
              {msg.credits ? `${msg.credits} credits` : ""}
              {msg.undone ? " · undone" : ""}
              {msg.status === "stopped" ? " · stopped" : ""}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
