"use client";

import Coachmark from "../Coachmark";
import DictateButton from "./DictateButton";
import RichInput from "./RichInput";
import { expandRefs } from "@/lib/composer-format";
import AnnotateDialog from "./AnnotateDialog";
import ConnectorsPanel from "../ConnectorsPanel";
import { detectPastedCredential } from "@/lib/connector-patterns";
import { spaceNames, collectionNames, projectNames } from "./project-names";
import { useEffect, useRef, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { useEscape } from "../useEscape";
import Link from "next/link";
import { AudioLines, Check, ChevronDown, FileText, Loader2, Paperclip, Pencil, Plus, Square, X } from "lucide-react";
import type { Attachment, Mode } from "./types";
import { usePerms } from "../iotx/PermsProvider";

type Pending = Attachment & { uploading?: boolean; error?: string; warn?: string; pasted?: string };

export type Intent = { label: string; run: () => void };

const MODES: { id: Mode; title: string }[] = [
  { id: "build", title: "Make changes to the project" },
  { id: "plan", title: "Plan first: the agent proposes a plan you approve before building" },
  { id: "ask", title: "Ask about the project without changing it" },
  { id: "design", title: "Visual and styling changes only" },
  { id: "goal", title: "Goal: the agent makes a task list and keeps working through it on its own, up to 5 turns" },
];

const SLASH: { cmd: string; hint: string }[] = [
  { cmd: "/build", hint: "Switch to Build mode" },
  { cmd: "/plan", hint: "Switch to Plan mode" },
  { cmd: "/ask", hint: "Switch to Ask mode" },
  { cmd: "/design", hint: "Switch to Design mode" },
  { cmd: "/goal", hint: "Goal mode: keeps working until it's done. Goal runs use more credits." },
  { cmd: "/tasks", hint: "Open the task list" },
  { cmd: "/history", hint: "Open version history" },
  { cmd: "/stop", hint: "Stop the running turn" },
];

const INTERVIEW_PROMPT =
  "Interview me about my latest request. Help me work through the important decisions before we build.";

/** Pastes longer than this become a text attachment instead of flooding the box. */
const SMART_PASTE_CHARS = 2000;

// Sent messages are stored in the chat history and passed to the model, so a
// pasted credential effectively leaks. Private keys are refused outright;
// API keys and personal data get a warning the user can override.
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const KEY_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "Anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "OpenAI", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { label: "AWS", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "Stripe secret", re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/ },
  { label: "Slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const PII: { label: string; test: (t: string) => boolean }[] = [
  {
    label: "a payment card number",
    test: (t) => (t.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []).some((m) => luhn(m.replace(/\D/g, ""))),
  },
  { label: "a bank account number (IBAN)", test: (t) => /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/.test(t) },
  { label: "a US social security number", test: (t) => /\b\d{3}-\d{2}-\d{4}\b/.test(t) },
  // Exactly three groups: a 12-digit tail of a longer number is not an Aadhaar.
  { label: "an Aadhaar number", test: (t) => /(?<![\d][\s-]?)\b[2-9]\d{3}\s\d{4}\s\d{4}\b(?![\s-]?\d)/.test(t) },
  { label: "a PAN number", test: (t) => /\b[A-Z]{5}\d{4}[A-Z]\b/.test(t) },
];

export function inspectOutgoing(text: string): { kind: "block" | "warn"; message: string } | null {
  if (PRIVATE_KEY.test(text)) {
    return { kind: "block", message: "Private keys can't be sent in chat. Remove it and keep it somewhere secure." };
  }
  const key = KEY_PATTERNS.find((k) => k.re.test(text));
  if (key) {
    return {
      kind: "warn",
      message: `Sensitive ${key.label} API key detected. Messages are kept in the chat history and sent to the model — store keys as secrets instead.`,
    };
  }
  const pii = PII.find((p) => p.test(text));
  if (pii) {
    return { kind: "warn", message: `This message looks like it contains ${pii.label}. Make sure that's OK to share before sending.` };
  }
  return null;
}

export default function ChatComposer({
  projectId,
  files,
  mode,
  setMode,
  building,
  queuedCount,
  paused,
  intents,
  selectedLabel,
  onClearSelected,
  onSend,
  onStop,
  onTogglePause,
  onClearQueue,
  onOpen,
  onTalk,
  onVariants,
  quote,
  preattach,
}: {
  projectId: string;
  files: string[];
  mode: Mode;
  setMode: (m: Mode) => void;
  building: boolean;
  queuedCount: number;
  paused: boolean;
  intents: Intent[];
  selectedLabel: string | null;
  onClearSelected: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onTogglePause: () => void;
  onClearQueue: () => void;
  onOpen: (panel: "history" | "settings" | "tasks" | "files" | "cloud" | "design") => void;
  /** Start a live voice conversation. */
  onTalk?: () => void;
  /** Build the typed request three ways; resolves to an error message or null. */
  onVariants?: (text: string) => Promise<string | null>;
  /** Text picked with "Reply" in the chat; quoted into the box (n changes per reply). */
  quote?: { text: string; n: number } | null;
  /** Files to start with, e.g. "Ask about this file" from Chat files. */
  preattach?: Attachment[] | null;
}) {
  const brand = useBrand();
  const [input, setInput] = useState("");
  // Items picked with the suite's @ (an article, a sheet, a task…): label -> link, added back on send.
  const [links, setLinks] = useState<Record<string, string>>({});
  // IOTx Suite 2-in-1: Ask is for everyone; Plan, Build, Design and Goal appear with the Builder switch.
  const perms = usePerms();
  const modeAllowed = (m: Mode) => (m === "ask" ? perms.can("home.ask") : m === "plan" ? perms.builder && perms.can("builder.plan") : perms.builder && perms.can("builder.build"));
  const modes = MODES.filter((m) => modeAllowed(m.id));
  const builderOnly = !modeAllowed("build");
  const MENU_KEYS: Record<string, () => boolean> = {
    "Codebase (.zip)": () => modeAllowed("build"),
    Databases: () => perms.builder,
    Design: () => modeAllowed("build"),
    "Interview me": () => modeAllowed("plan"),
    "Create 3 variants": () => modeAllowed("build"),
    Connectors: () => perms.builder && perms.can("builder.connectors"),
    GitHub: () => perms.builder && perms.can("builder.github"),
    "Project settings": () => perms.builder,
  };
  const menuOk = (label: string) => !MENU_KEYS[label] || MENU_KEYS[label]();
  useEffect(() => {
    if (!modeAllowed(mode) && modes[0]) setMode(modes[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, perms]);
  // Other parts of the editor can start a message (e.g. "Revise plan").
  useEffect(() => {
    const onCompose = (e: Event) => {
      setInput((e as CustomEvent<string>).detail);
      requestAnimationFrame(() => boxRef.current?.focus());
    };
    window.addEventListener("forge:compose", onCompose);
    return () => window.removeEventListener("forge:compose", onCompose);
  }, []);
  const [pending, setPending] = useState<Pending[]>([]);
  useEffect(() => {
    if (!preattach?.length) return;
    setPending((p) => [...p, ...preattach.filter((a) => !p.some((x) => x.id === a.id))]);
    setInput((v) => v || "What's in this file? Tell me what's useful in it for this project.");
  }, [preattach]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [skills, setSkills] = useState<{ name: string; title: string; description: string; instructions?: string }[]>([]);
  useEffect(() => {
    fetch("/api/workspace/skills")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSkills([...(d.skills ?? []), ...((d.personal ?? []) as { name: string }[]).filter((p) => !(d.skills ?? []).some((w: { name: string }) => w.name === p.name))]))
      .catch(() => undefined);
  }, []);
  const [variantNote, setVariantNote] = useState<string | null>(null);
  useEffect(() => {
    if (!quote) return;
    const quoted = quote.text
      .trim()
      .split(/\r?\n/)
      .map((l) => `> ${l}`)
      .join("\n");
    setInput((v) => `${v ? `${v.trimEnd()}\n\n` : ""}${quoted}\n\n`);
    requestAnimationFrame(() => {
      const el = boxRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [quote]);
  const [dragging, setDragging] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [guard, setGuard] = useState<{ kind: "block" | "warn"; message: string } | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // "Codebase" and "Zipped folder" pick a .zip; a codebase also asks the agent to bring it in.
  const zipRef = useRef<HTMLInputElement>(null);
  const zipIntent = useRef<"codebase" | "folder">("folder");
  // Connectors: mentionable with @, and offered when a credential is pasted.
  const [connectors, setConnectors] = useState<string[]>([]);
  // Other projects in the workspace, @-mentionable.
  const [projects, setProjects] = useState<string[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [connectorsOpen, setConnectorsOpen] = useState<null | { kind?: string; value?: string }>(null);
  useEscape(connectorsOpen ? () => setConnectorsOpen(null) : null);
  const [credential, setCredential] = useState<{ kind: string; name: string; value: string } | null>(null);
  const [freeLeft, setFreeLeft] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState<{ id: string; name: string } | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);

  /** Capture the current tab (the user picks it in the browser's prompt) as an image attachment. */
  async function takeScreenshot() {
    setShotError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions);
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 250));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (blob) await upload([new File([blob], `Screenshot ${new Date().toLocaleTimeString()}.png`, { type: "image/png" })]);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) setShotError("Couldn't take a screenshot in this browser.");
    }
  }
  const chatMode = mode === "ask" || mode === "plan";
  useEffect(() => {
    if (!chatMode) return;
    let live = true;
    fetch("/api/workspace/allowance")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) {
          setFreeLeft(d.freeChatsLeft);
          setPlan(d.plan);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [chatMode, building]);
  useEffect(() => {
    let live = true;
    // Projects, plus the sidebar's dashboards and folders (the agent reads those with read_space).
    void Promise.all([projectNames(projectId), spaceNames()]).then(([list, spaces]) => live && setProjects([...list.map((p) => p.name), ...spaces]));
    void collectionNames(projectId).then((list) => live && setCollections(list));
    return () => {
      live = false;
    };
  }, [projectId]);
  useEffect(() => {
    let live = true;
    fetch(`/api/workspace/connectors?projectId=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setConnectors(d.connections.map((c: { label: string }) => c.label));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, connectorsOpen]);

  // --- uploads -------------------------------------------------------------
  async function upload(list: File[], pasted?: string) {
    for (const file of list.slice(0, 10)) {
      // Text attachments (and smart pastes) get the same key and personal-data checks as messages.
      let warn: string | undefined;
      if (file.size <= 2_000_000 && (/^text\//.test(file.type) || /\.(txt|md|csv|json|env|ya?ml|log|html?|js|ts|tsx|sql)$/i.test(file.name))) {
        const issue = inspectOutgoing(await file.text().catch(() => ""));
        if (issue?.kind === "block") {
          setGuard({ kind: "block", message: `"${file.name}" contains a private key, so it wasn't attached.` });
          continue;
        }
        if (issue) warn = issue.message;
      }
      const temp: Pending = { id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, uploading: true };
      setPending((p) => [...p, temp]);
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch(`/api/projects/${projectId}/uploads`, { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Upload failed");
        setPending((p) => p.map((x) => (x.id === temp.id ? { ...body.attachments[0], warn, pasted } : x)));
      } catch (e) {
        setPending((p) =>
          p.map((x) => (x.id === temp.id ? { ...x, uploading: false, error: e instanceof Error ? e.message : "Upload failed" } : x)),
        );
      }
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pastedFiles = Array.from(e.clipboardData.files);
    if (pastedFiles.length) {
      e.preventDefault();
      void upload(pastedFiles);
      return;
    }
    const text = e.clipboardData.getData("text");
    const cred = detectPastedCredential(text);
    if (cred) setCredential(cred);
    if (text.length > SMART_PASTE_CHARS) {
      e.preventDefault();
      const kind = /^\s*[{[]/.test(text) ? "json" : /<\/?[a-z][\s\S]*>/i.test(text) ? "html" : "txt";
      const lines = text.split("\n").length;
      void upload([new File([text], `Pasted text (${lines} lines).${kind}`, { type: kind === "json" ? "application/json" : "text/plain" })], text);
    }
  }

  // --- @mentions and /commands ----------------------------------------------
  const caret = boxRef.current?.selectionStart ?? input.length;
  const beforeCaret = input.slice(0, caret);
  // In the suite, its global @ picker takes over (this composer's extras show there under "This page").
  const mention = suiteAt() ? null : /(^|\s)@([\w./-]*)$/.exec(beforeCaret);
  const mentionMatches = mention
    ? [
        ...connectors.filter((c) => c.toLowerCase().includes(mention[2].toLowerCase())),
        ...projects.filter((p) => p.toLowerCase().includes(mention[2].toLowerCase())),
        ...collections.filter((c) => c.toLowerCase().includes(mention[2].toLowerCase())),
        ...files.filter((f) => f.toLowerCase().includes(mention[2].toLowerCase())),
      ].slice(0, 8)
    : [];
  // Built-in commands first, then the workspace's skills (which keep the text so details can follow).
  const commands = [...SLASH.filter((s) => !["/build", "/plan", "/ask", "/design", "/goal"].includes(s.cmd) || modeAllowed(s.cmd.slice(1) as Mode)), ...skills.map((k) => ({ cmd: `/${k.name}`, hint: k.description || k.title, skill: true }))];
  const slash = /^\/[\w-]*$/.test(input) ? commands.filter((s) => s.cmd.startsWith(input)) : [];
  const menuItems = slash.length ? slash.map((s) => s.cmd) : mentionMatches;

  // This composer's own @ things for the suite's global picker: connectors, collections and files.
  useEffect(() => {
    if (!suiteAt()) return;
    const w = window as unknown as { __iotxMentionLocal?: () => { title: string; items: { label: string; sub?: string; insert: string }[] } };
    w.__iotxMentionLocal = () => ({
      title: "This project",
      items: [
        ...connectors.map((c) => ({ label: c, sub: "Connector", insert: `@${c}` })),
        ...collections.map((c) => ({ label: c, sub: "Collection", insert: `@${c}` })),
        ...files.map((f) => ({ label: f, sub: "File", insert: `@${f}` })),
      ],
    });
    return () => {
      delete w.__iotxMentionLocal;
    };
  }, [connectors, collections, files]);

  function pick(value: string) {
    if (slash.length) {
      runSlash(value);
      return;
    }
    if (!mention) return;
    const start = caret - mention[2].length - 1;
    const next = `${input.slice(0, start)}@${value} ${input.slice(caret)}`;
    setInput(next);
    setHighlight(0);
    requestAnimationFrame(() => boxRef.current?.focus());
  }

  function runSlash(cmd: string) {
    if (!SLASH.some((s) => s.cmd === cmd)) {
      // A skill: keep it in the box so the person can add details, then send.
      setInput(`${cmd} `);
      setHighlight(0);
      requestAnimationFrame(() => boxRef.current?.focus());
      return;
    }
    setInput("");
    setHighlight(0);
    if (cmd === "/build" || cmd === "/plan" || cmd === "/ask" || cmd === "/design" || cmd === "/goal") {
      if (modeAllowed(cmd.slice(1) as Mode)) setMode(cmd.slice(1) as Mode);
    }
    else if (cmd === "/tasks") onOpen("tasks");
    else if (cmd === "/history") onOpen("history");
    else if (cmd === "/stop") onStop();
  }

  function submit(force = false) {
    const ready = pending.filter((p) => !p.uploading && !p.error);
    if (!input.trim() && ready.length === 0) return;
    if (/^\/\w+$/.test(input.trim()) && SLASH.some((s) => s.cmd === input.trim())) {
      runSlash(input.trim());
      return;
    }
    const flagged = ready.find((p) => p.warn);
    const issue = inspectOutgoing(input) ?? (flagged ? { kind: "warn" as const, message: `Attachment "${flagged.name}": ${flagged.warn}` } : null);
    if (issue && (issue.kind === "block" || !force)) {
      setGuard(issue);
      return;
    }
    setGuard(null);
    onSend(expandRefs(input.trim(), links) || "See the attached files.", ready.map(({ id, name, type, size }) => ({ id, name, type, size })));
    setInput("");
    setLinks({});
    setPending([]);
  }

  const uploading = pending.some((p) => p.uploading);

  return (
    <div className="border-t p-3">
      {queuedCount > 0 && (
        <div className="mb-2 flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-[11px]">
          <span style={{ color: "var(--muted)" }}>
            {queuedCount} message{queuedCount === 1 ? "" : "s"} queued{paused ? " · paused" : ""}
          </span>
          <span className="flex gap-2">
            <button onClick={onTogglePause} className="hover:underline">
              {paused ? "Resume" : "Pause"}
            </button>
            <button onClick={onClearQueue} className="hover:underline">
              Clear
            </button>
          </span>
        </div>
      )}

      {variantNote && (
        <p role="status" className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[11px]">
          {variantNote}
          <button onClick={() => setVariantNote(null)} aria-label="Dismiss" className="shrink-0">
            <X className="h-3 w-3" />
          </button>
        </p>
      )}

      {intents.length > 0 && (
        <div className="-mx-3 mb-2 flex gap-1.5 overflow-x-auto px-3 [scrollbar-width:none]">
          {intents.map((i) => (
            <button
              key={i.label}
              onClick={i.run}
              className="h-7 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              style={{ background: "var(--panel)" }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}

      <div
        className={`relative rounded-2xl border p-2.5 transition-shadow focus-within:ring-2 focus-within:ring-[var(--accent-soft)] ${dragging ? "ring-2 ring-[#6d4aff]" : ""}`}
        style={{ background: "var(--panel)", boxShadow: "var(--shadow-surface)" }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        {menuItems.length > 0 && (
          <ul
            role="listbox"
            aria-label={slash.length ? "Commands" : "Mention a file"}
            className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto rounded-xl border p-1 shadow-lg"
            style={{ background: "var(--panel)" }}
          >
            {menuItems.map((item, i) => (
              <li key={item}>
                <button
                  role="option"
                  aria-selected={i === highlight}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(item);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-xs ${
                    i === highlight ? "bg-black/[.06] dark:bg-white/[.08]" : ""
                  }`}
                >
                  <span className="truncate font-mono">{item}</span>
                  {slash.length > 0 && (
                    <span style={{ color: "var(--muted)" }}>{commands.find((s) => s.cmd === item)?.hint}</span>
                  )}
                  {!slash.length && connectors.includes(item) && <span style={{ color: "var(--muted)" }}>connector</span>}
                  {!slash.length && projects.includes(item) && <span style={{ color: "var(--muted)" }}>project</span>}
                  {!slash.length && collections.includes(item) && <span style={{ color: "var(--muted)" }}>collection</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Skill preview: what the highlighted skill will tell the agent. */}
        {slash.length > 0 &&
          (() => {
            const skill = skills.find((k) => `/${k.name}` === menuItems[highlight]);
            if (!skill) return null;
            return (
              <aside
                aria-label={`Skill preview: ${skill.title || skill.name}`}
                className="absolute bottom-full right-0 z-30 mb-1 hidden w-72 translate-x-[calc(100%+8px)] rounded-xl border p-3 text-xs shadow-lg lg:block"
                style={{ background: "var(--panel)" }}
              >
                <p className="font-medium">{skill.title || skill.name}</p>
                {skill.description && <p className="mt-0.5" style={{ color: "var(--muted)" }}>{skill.description}</p>}
                {skill.instructions && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[.04] p-2 font-sans text-[11px] leading-relaxed dark:bg-white/[.05]">
                    {skill.instructions.slice(0, 1200)}
                  </pre>
                )}
                <p className="mt-2" style={{ color: "var(--muted)" }}>Add details after the command, then send.</p>
              </aside>
            );
          })()}

        {credential && (
          <div role="alert" className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] dark:bg-amber-950/30">
            <span>
              That looks like a {credential.name} key. With a native connector it&apos;s stored encrypted and reused securely,
              instead of being sent in chat.
            </span>
            <span className="flex gap-1.5">
              <button onClick={() => setCredential(null)} className="rounded-md px-2 py-0.5">
                Keep in message
              </button>
              <button
                onClick={() => {
                  setInput((v) => v.split(credential.value).join("").replace(/\s{2,}/g, " ").trim());
                  setConnectorsOpen({ kind: credential.kind, value: credential.value });
                  setCredential(null);
                }}
                className="rounded-md bg-[#6d4aff] px-2 py-0.5 font-medium text-white"
              >
                Use {credential.name} connector
              </button>
            </span>
          </div>
        )}

        {guard && (
          <div
            role="alert"
            className={`mb-1.5 rounded-lg border px-2.5 py-2 text-[11px] ${
              guard.kind === "block" ? "border-red-300 bg-red-50 dark:bg-red-950/30" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"
            }`}
          >
            <p>{guard.message}</p>
            <div className="mt-1.5 flex justify-end gap-2">
              <button onClick={() => setGuard(null)} className="font-medium hover:underline">
                Edit message
              </button>
              {guard.kind === "warn" && (
                <button onClick={() => submit(true)} className="font-medium hover:underline">
                  Send anyway
                </button>
              )}
            </div>
          </div>
        )}

        {selectedLabel && (
          <div className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border px-2 py-1">
            <span className="truncate font-mono text-[11px]">{selectedLabel}</span>
            <button onClick={onClearSelected} aria-label="Clear selected element" className="shrink-0 text-[11px]" style={{ color: "var(--muted)" }}>
              Clear
            </button>
          </div>
        )}

        {pending.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {pending.map((p) => (
              <span key={p.id} className="flex max-w-[180px] items-center gap-1 rounded-lg border px-1.5 py-0.5 text-[11px]">
                {p.uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
                {!p.uploading && !p.error && p.type.startsWith("image/") && p.type !== "image/svg+xml" && (
                  <button
                    onClick={() => setAnnotating({ id: p.id, name: p.name })}
                    aria-label={`Annotate ${p.name}`}
                    title="Draw on this image"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
                <span className={`truncate ${p.error ? "text-red-600" : ""}`} title={p.error ?? p.name}>
                  {p.error ? `${p.name}: ${p.error}` : p.name}
                </span>
                {p.pasted && !p.uploading && (
                  <button
                    onClick={() => {
                      // Put the paste back in the message instead of attaching it.
                      setInput((v) => (v && !v.endsWith("\n") ? `${v}\n${p.pasted}` : `${v}${p.pasted}`));
                      setPending((list) => list.filter((x) => x.id !== p.id));
                    }}
                    title="Insert the pasted text into the message instead"
                    className="shrink-0 underline"
                  >
                    Insert
                  </button>
                )}
                <button onClick={() => setPending((x) => x.filter((y) => y.id !== p.id))} aria-label={`Remove ${p.name}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <RichInput
          ref={boxRef}
          value={input}
          onValue={(v) => {
            setInput(v);
            setHighlight(0);
          }}
          mentions={[...connectors, ...projects, ...collections, ...files, ...Object.keys(links)]}
          onRef={(label, url) => setLinks((l) => ({ ...l, [label]: url }))}
          commands={commands.map((c) => c.cmd)}
          menuOpen={menuItems.length > 0}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (menuItems.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => (h + 1) % menuItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => (h - 1 + menuItems.length) % menuItems.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pick(menuItems[highlight] ?? menuItems[0]);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          aria-label="Ask for a change"
          placeholder={building ? "Queue another message…" : "Ask for a change… (@ to mention a file, / for commands)"}
          className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:opacity-50"
        />

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-0.5">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void upload(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <input
              ref={zipRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (!list.length) return;
                void upload(list);
                if (zipIntent.current === "codebase") {
                  setMode("build");
                  setInput((v) => v || "Import the codebase in the attached .zip into this project and get it running in the preview.");
                }
              }}
            />
            <DictateButton onText={(t) => setInput((v) => (v && !v.endsWith(" ") ? `${v} ${t}` : `${v}${t}`))} />
            {onTalk && (
              <button
                onClick={onTalk}
                aria-label={`Talk to ${brand.shortName}`}
                title={`Talk to ${brand.shortName} out loud: a live, two-way voice conversation using your microphone`}
                className="rounded-md p-1 hover:bg-black/[.05] dark:hover:bg-white/[.08]"
                style={{ color: "var(--muted)" }}
              >
                <AudioLines className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach images, PDFs or documents"
              aria-label="Attach files"
              className="rounded-md p-1 hover:bg-black/[.05] dark:hover:bg-white/[.08]"
              style={{ color: "var(--muted)" }}
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-label="More actions"
                className="rounded-md p-1 hover:bg-black/[.05] dark:hover:bg-white/[.08]"
                style={{ color: "var(--muted)" }}
              >
                <Plus className="h-4 w-4" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-20 mb-1 w-44 rounded-xl border p-1 shadow-lg"
                  style={{ background: "var(--panel)" }}
                  onMouseLeave={() => setMenuOpen(false)}
                >
                  {(
                    [
                      ["Attach files", () => fileRef.current?.click()],
                      [
                        "Codebase (.zip)",
                        () => {
                          zipIntent.current = "codebase";
                          zipRef.current?.click();
                        },
                      ],
                      [
                        "Zipped folder",
                        () => {
                          zipIntent.current = "folder";
                          zipRef.current?.click();
                        },
                      ],
                      ["Databases", () => onOpen("cloud")],
                      ["Design", () => onOpen("design")],
                      [
                        "Interview me",
                        () => {
                          setMode("plan");
                          setInput(INTERVIEW_PROMPT);
                        },
                      ],
                      ["Mention a file", () => setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@`)],
                      ["Task list", () => onOpen("tasks")],
                      ["History", () => onOpen("history")],
                      ["Files", () => onOpen("files")],
                      ["Take a screenshot", () => void takeScreenshot()],
                      [
                        "Create 3 variants",
                        () => {
                          if (!onVariants) return;
                          if (!input.trim()) return setVariantNote("Type what to build, then choose Create 3 variants.");
                          void onVariants(input.trim()).then((err) => setVariantNote(err));
                        },
                      ],
                      ["Connectors", () => setConnectorsOpen({})],
                      ["GitHub", () => setConnectorsOpen({ kind: "github" })],
                      ["Search projects and chats", () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))],
                      ["Skills", () => (skills.length ? setInput("/") : window.open("/settings/skills", "_blank"))],
                      ["Project settings", () => onOpen("settings")],
                      ["Help", () => window.open(`/help${input.trim() ? `?q=${encodeURIComponent(input.trim().slice(0, 80))}` : ""}`, "_blank")],
                    ] as const
                  ).filter(([label]) => menuOk(label)).map(([label, run]) => (
                    <button
                      key={label}
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        run();
                        boxRef.current?.focus();
                      }}
                      className="block w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-black/[.05] dark:hover:bg-white/[.08]"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* One compact mode menu instead of five pills, so the composer stays on one line. */}
            <div className="relative ml-1">
              <Coachmark id="plan-mode" title="Plan before you build">
                Plan mode drafts a plan you can review and approve. Nothing changes until you do.
              </Coachmark>
              {chatMode && (
                <Coachmark id="chat-free" title="Chat for free">
                  Ask and Plan don&apos;t change your app, and they&apos;re free up to a daily allowance. Ask anything about the code or plan the next step.
                </Coachmark>
              )}
              <button
                onClick={() => setModeOpen((o) => !o)}
                aria-haspopup="true"
                aria-expanded={modeOpen}
                aria-label={`Mode: ${mode}`}
                className="flex h-7 items-center gap-0.5 rounded-lg px-2 text-xs font-medium capitalize hover:bg-black/[.05] dark:hover:bg-white/[.08]"
              >
                {mode} <ChevronDown className="h-3.5 w-3.5" style={{ color: "var(--muted)" }} />
              </button>
              {modeOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setModeOpen(false)} aria-hidden />
                  <div
                    role="radiogroup"
                    aria-label="Mode"
                    className="absolute bottom-full left-0 z-30 mb-1 w-72 rounded-xl border p-1 shadow-xl"
                    style={{ background: "var(--panel)" }}
                  >
                    {modes.map((m) => (
                      <button
                        key={m.id}
                        role="radio"
                        aria-checked={mode === m.id}
                        onClick={() => {
                          setMode(m.id);
                          setModeOpen(false);
                        }}
                        className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-black/[.05] dark:hover:bg-white/[.06]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium capitalize">{m.id}</span>
                          <span className="block text-xs" style={{ color: "var(--muted)" }}>
                            {m.title}
                          </span>
                        </span>
                        {mode === m.id && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {builderOnly && (
              <span className="text-[10px]" style={{ color: "var(--muted)" }} title="Building isn't turned on for your role. An admin can turn on Builder in Roles & permissions." data-testid="chat-only">
                Chat only
              </span>
            )}
            {chatMode && freeLeft !== null && (
              <span
                className="text-[10px]"
                style={{ color: "var(--muted)" }}
                title="Ask and Plan are free up to a daily allowance; after that they use credits. Resets at midnight UTC."
              >
                {freeLeft > 0 ? `Free · ${freeLeft} left today` : "Free allowance used up · uses credits"}
              </span>
            )}
            {chatMode && freeLeft === 0 && plan === "FREE" && (
              <Link href="/settings/billing" className="text-[10px] font-medium underline" style={{ color: "var(--accent)" }}>
                Upgrade for more
              </Link>
            )}
            {building && (
              <button
                onClick={onStop}
                title="Stop the running turn"
                aria-label="Stop"
                className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                <Square className="h-3 w-3 fill-current" /> Stop
              </button>
            )}
            <button
              onClick={() => submit()}
              disabled={uploading || (!input.trim() && pending.length === 0)}
              className="btn-primary rounded-lg px-3 py-1 text-xs font-medium"
            >
              {building ? "Queue" : "Send"}
            </button>
          </div>
        </div>
      </div>
      {annotating && (
        <AnnotateDialog
          src={`/api/projects/${projectId}/uploads/${annotating.id}`}
          name={annotating.name}
          onClose={() => setAnnotating(null)}
          onSave={(file) => {
            // The annotated copy replaces the original in this message.
            setPending((x) => x.filter((y) => y.id !== annotating.id));
            setAnnotating(null);
            void upload([file]);
          }}
        />
      )}
      {shotError && (
        <p className="px-3 pb-2 text-[11px] text-red-600" role="alert">
          {shotError}
        </p>
      )}
      {connectorsOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={() => setConnectorsOpen(null)}>
          <div
            role="dialog"
            aria-label="Connectors"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 shadow-2xl"
            style={{ background: "var(--panel)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Connectors</h2>
              <button onClick={() => setConnectorsOpen(null)} aria-label="Close" className="rounded-md p-1 hover:bg-black/[.05]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ConnectorsPanel
              projectId={projectId}
              prefill={connectorsOpen.kind ? { kind: connectorsOpen.kind, value: connectorsOpen.value } : undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Running in a suite tab whose frame has the global @ picker. */
function suiteAt() {
  try {
    return typeof window !== "undefined" && window.top !== window.self && !!(window.top as unknown as { __iotxMentions?: boolean }).__iotxMentions;
  } catch {
    return false;
  }
}
