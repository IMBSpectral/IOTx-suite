"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useBrand } from "@/components/BrandProvider";
import {
  Bell,
  BellOff,
  ChevronDown,
  History,
  ListChecks,
  MessageSquare,
  Monitor,
  Moon,
  ListOrdered,
  Maximize2,
  Expand,
  ExternalLink,
  Minimize2,
  MousePointer2,
  PencilLine,
  ArrowDownToLine,
  ArrowUpToLine,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Sun,
  Type,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import HistoryPanel from "./HistoryPanel";
import DraftBar from "./DraftBar";
import VariantsBar from "./VariantsBar";
import DailyIdeaCard from "./chat/DailyIdeaCard";
import TeamUpCard from "./chat/TeamUpCard";
import ProjectMenu from "./ProjectMenu";
import ShareDialog from "./ShareDialog";
import PresenceBar from "./PresenceBar";
import ProjectSettings from "./ProjectSettings";
import DevicePicker, { DEVICES, frameSize, type Device } from "./DevicePicker";
import MessageItem, { type MessageActions } from "./chat/MessageItem";
import ChatComposer, { type Intent } from "./chat/ChatComposer";
import TaskPanel from "./chat/TaskPanel";
import Tips from "./chat/Tips";
import ViewOnlyBar from "./chat/ViewOnlyBar";
import { usePerms } from "./iotx/PermsProvider";
import EmojiPicker from "./chat/EmojiPicker";
import PublishDialog, { publishLabel, type PublishInfo } from "./PublishDialog";
import SecurityCenter from "./SecurityCenter";
import HealthPanel, { useHealth } from "./HealthPanel";
import CommentsPanel, { type PendingPin } from "./CommentsPanel";
import LibraryPanel from "./LibraryPanel";
import CodePane, { type OpenFile } from "./code/CodePane";
import type { LiveFile } from "./chat/FileCards";
import BuildBar from "./BuildBar";
import VoiceSession from "./chat/VoiceSession";
import CloudPanel from "./CloudPanel";
import BrowserPanel from "./BrowserPanel";
import CanvasEditor from "./CanvasEditor";
import DesignSystemPanel from "./DesignSystemPanel";
import MarketingPanel from "./MarketingPanel";
import NotesPanel from "./NotesPanel";
import TerminalPanel from "./TerminalPanel";
import DrawOverlay from "./DrawOverlay";
import CleanupBanner from "./CleanupBanner";
import ArtifactsPanel from "./ArtifactsPanel";
import ChatSwitcher from "./chat/ChatSwitcher";
import { collectionNames, mentionedProjects, projectNames } from "./chat/project-names";
import SurveyPopover from "./SurveyPopover";
import { PreviewBooting, PreviewCrashed, PreviewPaused, PreviewStopped } from "./PreviewStates";
import BuildOverlay from "./BuildOverlay";
import { PendingTextBar, QuickEditBar, type TextChange } from "./VisualEditTools";
import type { ThreadView } from "@/lib/comments";
import type { Attachment, Mode, Msg, Task } from "./chat/types";
import { useTabTitle } from "./iotx/tabs";
import { readRefs, refsBlock } from "./iotx/ai";

export type { Msg } from "./chat/types";

type Tab = "preview" | "files" | "code" | "design" | "cloud" | "browser" | "grow" | "notes" | "artifacts" | "terminal" | "security" | "health" | "settings";

export default function Editor({
  projectId,
  projectName,
  projectEmoji,
  initialPreview,
  initialMessages,
  initialPublishedUrl,
  initialTasks,
  initialQueuePaused,
  initialIsTemplate = false,
  access = "admin",
  kind = "app",
  subdomain,
  customDomain,
  sidebar,
  chatId = null,
  draftNotice = null,
  historyError = false,
}: {
  /** The chat history couldn't be loaded: show an error with Retry, not an empty chat. */
  historyError?: boolean;
  /** Shown when the editor was opened from a link to a draft that's no longer open. */
  draftNotice?: string | null;
  /** The chat shown: one of the project's extra chats, or null for the main chat. */
  chatId?: string | null;
  projectId: string;
  projectName: string;
  projectEmoji: string | null;
  initialPreview: string;
  initialMessages: Msg[];
  initialPublishedUrl: string | null;
  initialTasks: Task[];
  initialQueuePaused: boolean;
  initialIsTemplate?: boolean;
  access?: "view" | "edit" | "admin";
  /** "app", "design_system" or "canvas". */
  kind?: string;
  subdomain: string;
  customDomain: string | null;
  /** The workspace sidebar, shown as a drawer from the top-left button. */
  sidebar?: React.ReactNode;
}) {
  const searchParams = useSearchParams();
  const brand = useBrand();
  // IOTx Suite 2-in-1: the same editor; builder actions show only with the matching switches.
  const perms = usePerms();
  const tabAllowed = (t: Tab) =>
    t === "code" ? perms.can("builder.code.view") : t === "design" ? perms.builder && perms.can("builder.build") : t === "terminal" ? perms.can("builder.code.edit") : t === "browser" ? perms.can("builder.browser") : t === "cloud" || t === "settings" || t === "grow" || t === "security" || t === "health" ? perms.builder : true;
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [stage, setStage] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("build");
  const [inspecting, setInspecting] = useState(false);
  const [pendingText, setPendingText] = useState<TextChange[]>([]);
  const [textEditing, setTextEditing] = useState(false);
  const [selected, setSelected] = useState<{
    selector: string;
    path: string;
    text: string;
  } | null>(null);
  const [emoji, setEmoji] = useState<string | null>(projectEmoji);
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [paused, setPaused] = useState(initialQueuePaused);
  const [notify, setNotify] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // A turn is in flight while any reply is queued or running.
  const building = messages.some((m) => m.role === "assistant" && (m.status === "queued" || m.status === "running"));
  const queuedCount = messages.filter((m) => m.role === "assistant" && m.status === "queued").length;
  const runningMsg = messages.find((m) => m.role === "assistant" && m.status === "running");

  useEffect(() => {
    try {
      setNotify(localStorage.getItem("forge:notify") === "on" && Notification.permission === "granted");
    } catch {}
  }, []);

  // The preview is a foreign origin by design, so postMessage is the only
  // channel between it and the editor.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.source !== "forge-preview") return;
      if (d.type === "selected" && commentingRef.current) {
        // Picked while commenting: start a thread pinned to that element.
        setPendingPin({
          locator: d.locator ?? "",
          selector: d.selector,
          text: d.text,
        });
        setCommentsOpen(true);
        setActiveThread(null);
        setCommenting(false);
        commentingRef.current = false;
        setInspecting(false);
      } else if (d.type === "selected") {
        setSelected({ selector: d.selector, path: d.path, text: d.text });
        setInspecting(false);
        // A picked element is almost always a visual change.
        setMode("design");
      } else if (d.type === "element-shot" && typeof d.image === "string") {
        // Arrives just after "selected"; attach it to the thread being started.
        setPendingPin((p) => (p && p.locator === (d.locator ?? "") ? { ...p, shot: d.image } : p));
      } else if (d.type === "pin-click") {
        setCommentsOpen(true);
        setActiveThread(String(d.id));
      } else if (d.type === "text-change") {
        // Typing over text that was already edited updates that change.
        setPendingText((all) => {
          const prev = all.findIndex((c) => c.newText === d.oldText);
          if (prev >= 0) return all.map((c, i) => (i === prev ? { ...c, newText: String(d.newText) } : c));
          return [
            ...all,
            {
              oldText: String(d.oldText),
              newText: String(d.newText),
              selector: String(d.selector),
            },
          ];
        });
      } else if (d.type === "pins-missing") {
        setMissingPins(new Set((d.ids as string[]) ?? []));
      } else if (d.type === "log") {
        // Batch the monitor's reports so a noisy page doesn't fire a request
        // per console line; the agent reads them through read_preview_logs.
        logQueue.current.push(d);
        if (!logTimer.current) {
          logTimer.current = setTimeout(() => {
            const entries = logQueue.current.splice(0);
            logTimer.current = null;
            void fetch(`/api/projects/${projectId}/runtime-logs`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ entries }),
            }).catch(() => undefined);
          }, 800);
        }
        if (d.level === "error" && (d.kind === "runtime" || d.kind === "resource") && !buildingRef.current) {
          setRuntimeError({
            message: String(d.message),
            stack: d.stack ? String(d.stack) : "",
          });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [projectId]);

  function toggleInspect() {
    const next = !inspecting;
    setInspecting(next);
    setCommenting(false);
    commentingRef.current = false;
    frameRef.current?.contentWindow?.postMessage({ source: "forge-editor", type: "inspect", enabled: next }, "*");
  }
  // Comments: pick an element to start a thread; pins are drawn in the preview.
  const [commentsOpen, setCommentsOpen] = useState(() => searchParams.get("comments") !== null);
  const [activeThread, setActiveThread] = useState<string | null>(() => searchParams.get("comments") || null);
  const [commenting, setCommenting] = useState(false);
  const commentingRef = useRef(false);
  const [pendingPin, setPendingPin] = useState<PendingPin | null>(null);
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [missingPins, setMissingPins] = useState<Set<string>>(new Set());
  const unreadThreads = threads.filter((t) => t.unread && !t.resolvedAt).length;
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/comments`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setThreads(d.threads);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);

  function toggleCommenting() {
    const next = !commenting;
    setCommenting(next);
    commentingRef.current = next;
    setInspecting(next);
    frameRef.current?.contentWindow?.postMessage({ source: "forge-editor", type: "inspect", enabled: next }, "*");
  }

  const postPins = useCallback(() => {
    const open = threads.filter((t) => !t.resolvedAt && t.locator);
    frameRef.current?.contentWindow?.postMessage(
      {
        source: "forge-editor",
        type: "pins",
        pins: commentsOpen
          ? open.map((t, i) => ({
              id: t.id,
              locator: t.locator,
              n: i + 1,
              active: t.id === activeThread,
            }))
          : [],
      },
      "*",
    );
  }, [threads, commentsOpen, activeThread]);
  useEffect(() => {
    postPins();
  }, [postPins]);

  const [voiceOpen, setVoiceOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(() => (searchParams.get("health") ? "health" : searchParams.get("tab") === "files" ? "files" : "preview"));
  const health = useHealth(projectId, tab === "health" ? 1 : 0);
  const [preview, setPreview] = useState(initialPreview);
  const [files, setFiles] = useState<string[]>([]);
  // The open file; "Open in code" from a selected element carries the line to select.
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  // The file the running turn is writing, streamed as it is written (chat cards, build view).
  // Mirrored in a ref so the stream handler can read it without waiting for a render.
  const [liveCode, setLiveCode] = useState<(LiveFile & { msgId: string }) | null>(null);
  const liveRef = useRef<(LiveFile & { msgId: string }) | null>(null);
  const putLive = useCallback((v: (LiveFile & { msgId: string }) | null) => {
    liveRef.current = v;
    liveDirty.current = false;
    setLiveCode(v);
  }, []);
  // A build streams many small events a second (reasoning words, reply words, code as it is
  // written). Repainting the whole editor for each one froze the page on long chats, so these
  // three are collected and painted at most every 100 ms. Any other event paints them first,
  // so the order on screen stays the order they arrived in.
  // Message buttons call the latest handlers through this, so messages that didn't change can skip redrawing.
  const actionsRef = useRef<MessageActions | null>(null);
  const [stableActions] = useState<MessageActions>(() => ({
    onOpenPath: (...a) => actionsRef.current?.onOpenPath(...a),
    onFeedback: (...a) => actionsRef.current?.onFeedback(...a),
    onUndo: (...a) => actionsRef.current?.onUndo(...a),
    onBookmark: (...a) => actionsRef.current?.onBookmark(...a),
    onRerun: (...a) => actionsRef.current?.onRerun(...a),
    onAnswer: (...a) => actionsRef.current?.onAnswer(...a),
    onApprovePlan: (...a) => actionsRef.current?.onApprovePlan(...a),
    onRevisePlan: () => actionsRef.current?.onRevisePlan?.(),
    onSwitchToBuild: (...a) => actionsRef.current?.onSwitchToBuild(...a),
    onRunNow: (...a) => actionsRef.current?.onRunNow(...a),
    onRemove: (...a) => actionsRef.current?.onRemove(...a),
    onMove: (...a) => actionsRef.current?.onMove?.(...a),
    onEditQueued: (...a) => actionsRef.current?.onEditQueued(...a),
  }));
  const liveDirty = useRef(false);
  const pendingThought = useRef<string | null>(null);
  const pendingReply = useRef<{ id: string; text: string } | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushStream = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const t = pendingReply.current;
    pendingReply.current = null;
    if (t) setMessages((all) => all.map((m) => (m.id === t.id ? { ...m, status: "running", content: m.content + t.text } : m)));
    if (pendingThought.current !== null) {
      setStage(pendingThought.current);
      pendingThought.current = null;
    }
    if (liveDirty.current) {
      liveDirty.current = false;
      setLiveCode(liveRef.current);
    }
  }, []);
  const soon = useCallback(() => {
    if (!flushTimer.current) flushTimer.current = setTimeout(flushStream, 100);
  }, [flushStream]);
  useEffect(() => () => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
  }, []);
  const codeViewRef = useRef(false);
  useEffect(() => {
    codeViewRef.current = perms.can("builder.code.view");
  });
  const [codeSaving, setCodeSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [device, setDevice] = useState<Device>(DEVICES[0]);
  const [landscape, setLandscape] = useState(false);
  const [theme, setTheme] = useState<"auto" | "light" | "dark">("auto");
  const [sandbox, setSandbox] = useState<{
    status: string;
    url: string | null;
    error?: string;
    reason?: string;
  }>({ status: "booting", url: null });
  // Crash recovery restarts once on its own; a second crash soon after waits for the user.
  const lastCrash = useRef(0);
  const [crashRestarting, setCrashRestarting] = useState(false);

  // Boot the project's dev container. Falls back to the bundled preview if
  // Docker is not available, so the editor still works without containers.
  const bootSandbox = useCallback(async () => {
    setSandbox({ status: "booting", url: null });
    try {
      const res = await fetch(`/api/projects/${projectId}/sandbox`, {
        method: "POST",
      });
      const d = await res.json();
      setSandbox({ status: d.status, url: d.url ?? null, error: d.error });
    } catch {
      setSandbox({
        status: "failed",
        url: null,
        error: "Could not reach the sandbox",
      });
    }
  }, [projectId]);

  // A canvas has nothing to run, so it never boots a dev container.
  useEffect(() => {
    if (kind !== "canvas") void bootSandbox();
  }, [bootSandbox, kind]);

  // Keep the container alive while the editor is open, and notice when it
  // was paused for being idle or stopped answering.
  useEffect(() => {
    if (sandbox.status !== "ready") return;
    let live = true;
    // Someone is here: the tab is visible and was used within the idle window.
    let lastUsed = Date.now();
    let idleMs = 10 * 60_000;
    const used = () => {
      lastUsed = Date.now();
    };
    const activity = ["pointerdown", "keydown", "pointermove", "wheel"] as const;
    for (const ev of activity) window.addEventListener(ev, used, { passive: true });
    const active = () => document.visibilityState === "visible" && Date.now() - lastUsed < idleMs;
    const check = () =>
      fetch(`/api/projects/${projectId}/sandbox?active=${active() ? 1 : 0}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!live || !d) return;
          if (d.idleMs) idleMs = d.idleMs;
          if (d.status === "stopped") {
            setSandbox({
              status: d.reason === "idle" ? "paused" : "stopped",
              url: null,
            });
          } else if (d.status === "crashed") {
            const again = Date.now() - lastCrash.current < 120_000;
            lastCrash.current = Date.now();
            setCrashRestarting(!again);
            setSandbox({ status: "crashed", url: null });
            if (!again) void bootSandbox().finally(() => setCrashRestarting(false));
          }
        })
        .catch(() => undefined);
    const t = setInterval(check, 30_000);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      for (const ev of activity) window.removeEventListener(ev, used);
    };
  }, [sandbox.status, projectId, bootSandbox]);
  const [name, setName] = useState(projectName);
  useTabTitle(name);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // "Reply" to a passage selected in an agent message.
  const [replyPick, setReplyPick] = useState<{ text: string; x: number; y: number } | null>(null);
  const [quote, setQuote] = useState<{ text: string; n: number } | null>(null);
  // /projects/<id>?ask=<uploadId>: open with that chat file attached ("Ask about this file").
  const [preattach, setPreattach] = useState<Attachment[] | null>(null);
  const firstBuild = useRef({ on: false, files: 0 });
  // The reasoning streamed so far in the current thinking block (the live status line).
  const thoughtRef = useRef("");
  // The build the person chose to "peek" through (the overlay stays hidden until the next one).
  const [peekBuild, setPeekBuild] = useState<string | null>(null);
  const [draftNoticeHidden, setDraftNoticeHidden] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // A document card in the chat opens that document in Artifacts.
  const [artifactId, setArtifactId] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      setArtifactId((e as CustomEvent<string>).detail);
      setTab("artifacts");
    };
    window.addEventListener("forge:open-artifact", onOpen);
    return () => window.removeEventListener("forge:open-artifact", onOpen);
  }, []);
  // An edited image (chat image editor) asks to be attached to the next message.
  useEffect(() => {
    const onAttach = (e: Event) => setPreattach([(e as CustomEvent<Attachment>).detail]);
    window.addEventListener("forge:preattach", onAttach);
    return () => window.removeEventListener("forge:preattach", onAttach);
  }, []);
  // Draw on the preview; the floating toolbar can sit at the top or bottom, or shrink to one button.
  const [drawing, setDrawing] = useState(false);
  const [dock, setDock] = useState<{ at: "top" | "bottom"; min: boolean }>(() => {
    try {
      return { at: "bottom", min: false, ...JSON.parse(localStorage.getItem("forge-toolbar") ?? "{}") };
    } catch {
      return { at: "bottom", min: false };
    }
  });
  const setDockSaved = (next: { at: "top" | "bottom"; min: boolean }) => {
    setDock(next);
    try {
      localStorage.setItem("forge-toolbar", JSON.stringify(next));
    } catch {}
  };
  useEffect(() => {
    const ask = searchParams.get("ask");
    if (!ask) return;
    fetch(`/api/projects/${projectId}/uploads`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { files: Attachment[] } | null) => {
        const f = d?.files.find((x) => x.id === ask);
        if (!f) return;
        setPreattach([{ id: f.id, name: f.name, type: f.type, size: f.size }]);
        // A question about a file shouldn't change the app.
        setMode("ask");
      })
      .catch(() => undefined);
  }, [projectId, searchParams]);
  useEffect(() => {
    if (!navOpen) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navOpen]);
  const [chatHidden, setChatHidden] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [draftsVersion, setDraftsVersion] = useState(0);
  const [runtimeError, setRuntimeError] = useState<{
    message: string;
    stack: string;
  } | null>(null);
  // While the agent writes files the preview hot-reloads half-finished code,
  // so errors from then aren't the app's real state. They're ignored, and when
  // the build ends old errors are cleared and the preview reloads, so a real
  // error in the finished code is reported fresh.
  const buildingRef = useRef(building);
  const wasBuilding = useRef(building);
  const logQueue = useRef<unknown[]>([]);
  const logTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Notifications about access requests link here with ?share=1.
  const [shareOpen, setShareOpen] = useState(() => searchParams.get("share") === "1");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishInfo, setPublishInfo] = useState<PublishInfo | null>(null);
  const published = publishInfo?.url ?? initialPublishedUrl;
  const onPublishInfo = useCallback((i: PublishInfo) => setPublishInfo(i), []);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Bumped whenever the app may have changed (a build finished, undo, restore, a draft moved), so the
  // Publish button re-checks against the live version instead of waiting for a page refresh.
  const [changeKey, setChangeKey] = useState(0);
  const refreshFiles = useCallback(async () => {
    setChangeKey((k) => k + 1);
    const res = await fetch(`/api/projects/${projectId}/files`);
    if (res.ok) setFiles((await res.json()).files ?? []);
  }, [projectId]);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const patchMsg = useCallback(
    (id: string, fn: (m: Msg) => Msg) => setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m))),
    [],
  );

  const reloadPreview = useCallback(() => {
    setChangeKey((k) => k + 1);
    setPreview((u) => u.replace(/sha=[^&]*/, `sha=${Date.now()}`));
    const frame = frameRef.current;
    if (frame?.src) frame.src = frame.src;
  }, []);

  // When a build ends: drop errors from the half-built code and reload so real ones are reported fresh.
  useEffect(() => {
    buildingRef.current = building;
    if (wasBuilding.current && !building) {
      setRuntimeError(null);
      reloadPreview();
    }
    wasBuilding.current = building;
  }, [building, reloadPreview]);

  /**
   * Post a message. It never waits for the current turn: the server queues it
   * and the follower below picks it up when its turn comes.
   */
  const send = useCallback(
    async (text: string, modeOverride?: Mode, attachments: Attachment[] = [], extra: { freeFix?: boolean } = {}) => {
      const turnMode = modeOverride ?? mode;
      const typed = text.trim();
      if (!typed) return;

      // A picked element is turned into context the model can act on, rather
      // than making the user describe what they just clicked.
      const mentions = [...typed.matchAll(/(?:^|\s)@([\w./-]+\.\w+)/g)].map((m) => m[1]);
      let prompt = selected
        ? `${typed}\n\n---\nTarget element in the rendered page:\n` +
          `  selector: ${selected.selector}\n` +
          `  dom path: ${selected.path}\n` +
          (selected.text ? `  text: ${JSON.stringify(selected.text)}\n` : "") +
          `Find this element in the source and change only it.`
        : typed;
      if (mentions.length) {
        prompt += `\n\nFiles the user referenced (read them first): ${mentions.join(", ")}`;
      }
      // @Project mentions: the agent can read those projects with read_project.
      if (typed.includes("@")) {
        const projects = mentionedProjects(typed, await projectNames(projectId));
        if (projects.length) prompt += `\n\nOther projects the user referenced (use read_project to look at them): ${projects.map((p) => `"${p.name}"`).join(", ")}`;
        const cols = (await collectionNames(projectId)).filter((c) => typed.includes(`@${c}`));
        if (cols.length) prompt += `\n\nCollections the user referenced (use read_collection to see their files): ${cols.map((c) => `"${c}"`).join(", ")}`;
      }

      // @ references from the suite-wide picker (a task, a channel, a sheet…), read now as this person.
      if (typed.includes("[@")) prompt += refsBlock(await readRefs(typed));

      setSelected(null);
      // A new turn supersedes whatever the preview last reported.
      setRuntimeError(null);
      const localId = crypto.randomUUID();
      setMessages((m) => [
        ...m,
        {
          id: localId,
          role: "user",
          content: typed,
          files: [],
          attachments,
          mode: turnMode,
        },
        {
          id: `${localId}-a`,
          role: "assistant",
          content: "",
          files: [],
          mode: turnMode,
          status: "queued",
        },
      ]);

      try {
        const res = await fetch(`/api/projects/${projectId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: prompt,
            mode: turnMode,
            attachmentIds: attachments.map((a) => a.id),
            ...(extra.freeFix ? { freeFix: true } : {}),
            ...(chatId ? { chatId } : {}),
          }),
        });
        if (res.status === 402) {
          const d = (await res.json().catch(() => ({}))) as {
            error?: string;
            hint?: string;
          };
          const content = d.hint
            ? `${d.error} ${d.hint}`
            : "You're out of credits. Top up or upgrade in Settings → Billing.";
          patchMsg(`${localId}-a`, (m) => ({
            ...m,
            content,
            status: "failed",
          }));
          return;
        }
        if (res.status === 429) {
          // Over the plan's message rate: say when to retry, and nudge free plans to upgrade.
          const d = (await res.json().catch(() => ({}))) as { error?: string; retryAfter?: number; upgrade?: boolean };
          const wait = d.retryAfter ? ` You can send again in about ${d.retryAfter < 90 ? `${d.retryAfter} seconds` : `${Math.ceil(d.retryAfter / 60)} minutes`}.` : "";
          patchMsg(`${localId}-a`, (m) => ({
            ...m,
            content: `${d.error ?? "You're sending messages too quickly."}${wait}${d.upgrade ? " [See plans with higher limits](/settings/billing)" : ""}`,
            status: "failed",
          }));
          return;
        }
        if (!res.ok) throw new Error("Could not send the message");
        const body = (await res.json()) as {
          buildId: string;
          userMessageId: string;
          messageId: string;
        };
        // Swap the optimistic ids for the real ones; the follower keys on buildId.
        setMessages((all) =>
          all.map((m) =>
            m.id === localId
              ? { ...m, id: body.userMessageId }
              : m.id === `${localId}-a`
                ? { ...m, id: body.messageId, buildId: body.buildId }
                : m,
          ),
        );
      } catch (e) {
        patchMsg(`${localId}-a`, (m) => ({
          ...m,
          content: e instanceof Error ? e.message : "Could not send the message",
          status: "failed",
        }));
      }
    },
    [projectId, mode, selected, patchMsg, chatId],
  );

  /** Follow one build's event stream until it finishes. */
  const follow = useCallback(
    async (msgId: string, buildId: string) => {
      // A browser notification when the agent stops to ask something.
      const needsInput = () => {
        if (!notify || !document.hidden) return;
        try {
          new Notification(`${brand.shortName} needs your input`, {
            body: name,
            tag: `forge-input-${projectId}`,
          });
        } catch {}
      };
      const stream = await fetch(`/api/builds/${buildId}/events`);
      if (!stream.body) throw new Error("No event stream");
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const seen = new Set<number>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";

        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue;
          const ev = JSON.parse(chunk.slice(6));
          // Replay and live fan-out can overlap; seq makes that harmless.
          if (typeof ev.seq === "number" && ev.seq > 0) {
            if (seen.has(ev.seq)) continue;
            seen.add(ev.seq);
          }
          if (ev.type !== "thought" && ev.type !== "text" && ev.type !== "file_stream") flushStream();
          if (ev.type === "closed") {
            // The stream ended without a live "done" (the turn finished before
            // we attached): take the final state from the server.
            if (ev.status) {
              patchMsg(msgId, (m) =>
                m.status === "queued" || m.status === "running"
                  ? {
                      ...m,
                      status: ev.status === "SUCCEEDED" ? "done" : ev.status === "CANCELLED" ? "stopped" : "failed",
                    }
                  : m,
              );
            }
            break;
          }

          if (ev.type === "build_started") {
            patchMsg(msgId, (m) => ({ ...m, status: "running" }));
            // The project's very first build is narrated as it takes shape.
            firstBuild.current = { on: false, files: 0 };
            setMessages((all) => {
              firstBuild.current.on = !all.some((m) => m.id !== msgId && m.role === "assistant" && m.status === "done" && m.files.some((f) => f.startsWith("write:")));
              return all;
            });
            thoughtRef.current = "";
            setStage("Reading your request…");
            putLive(null);
          } else if (ev.type === "thought") {
            // The agent's reasoning as it streams: show its latest line.
            thoughtRef.current = (thoughtRef.current + ev.delta).slice(-2000);
            const line = thoughtRef.current.trim().split(/\n+/).pop()?.replace(/[*#`_]/g, "").trim();
            if (line) {
              pendingThought.current = `Thinking: ${line.length > 160 ? "…" + line.slice(-160) : line}`;
              soon();
            }
          } else if (ev.type === "activity") {
            thoughtRef.current = "";
            setStage(activityLabel(ev.tool));
          } else if (ev.type === "file_stream") {
            // A file's code as the agent writes it: a new file shows at once, its growth every 100 ms.
            const c = liveRef.current;
            if (!ev.start && c && c.msgId === msgId && c.path === ev.path && !c.done) {
              liveRef.current = { ...c, content: c.content + ev.delta };
              liveDirty.current = true;
              soon();
            } else {
              flushStream();
              pendingThought.current = null;
              if (ev.start) setStage(`Writing ${ev.path}`);
              putLive({ msgId, path: ev.path, content: ev.delta, done: false });
            }
          } else if (ev.type === "text") {
            if (thoughtRef.current) {
              thoughtRef.current = "";
              pendingThought.current = null;
              setStage("Writing the reply…");
            }
            const t = pendingReply.current;
            if (t && t.id !== msgId) flushStream();
            pendingReply.current = { id: msgId, text: (pendingReply.current?.text ?? "") + ev.delta };
            soon();
          } else if (ev.type === "file") {
            if (firstBuild.current.on) ++firstBuild.current.files;
            setStage(`${ev.op === "delete" ? "Deleted" : "Saved"} ${ev.path}`);
            const step = `${ev.op}:${ev.path}`;
            patchMsg(msgId, (m) => (m.files.includes(step) ? m : { ...m, files: [...m.files, step] }));
            if (ev.op === "write") {
              const c = liveRef.current;
              const path = ev.path as string;
              if (c && c.msgId === msgId && c.path === path) putLive({ ...c, done: true });
              else if (codeViewRef.current && /\.(tsx?|jsx?|mjs|cjs|css|html|json|md|sql)$/i.test(path)) {
                // Written without streaming (another tool): fetch it once for the build view.
                putLive({ msgId, path, content: "", done: true });
                void fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`)
                  .then((r) => (r.ok ? r.json() : null))
                  .then((d: { content?: string } | null) => {
                    const now = liveRef.current;
                    if (d?.content && now && now.msgId === msgId && now.path === path && !now.content) putLive({ ...now, content: d.content });
                  })
                  .catch(() => undefined);
              }
            }
          } else if (ev.type === "tool") {
            patchMsg(msgId, (m) => (m.files.includes(ev.step) ? m : { ...m, files: [...m.files, ev.step] }));
            if (/^(cloud|migration|secret|switch):/.test(ev.step)) needsInput();
          } else if (ev.type === "questions") {
            patchMsg(msgId, (m) => ({
              ...m,
              files: [...m.files, `questions:${JSON.stringify(ev.questions)}`],
            }));
            needsInput();
          } else if (ev.type === "memory") {
            patchMsg(msgId, (m) => ({
              ...m,
              files: [...m.files, `memory:${ev.fact}`],
            }));
          } else if (ev.type === "tasks") {
            setTasks(ev.tasks);
            const doneCount = ev.tasks.filter((t: Task) => t.status === "done").length;
            patchMsg(msgId, (m) => ({
              ...m,
              files: [...m.files, `tasks:${doneCount}/${ev.tasks.length}`],
            }));
          } else if (ev.type === "draft_opened" || ev.type === "draft_ready") {
            setDraftsVersion((v) => v + 1);
          } else if (ev.type === "stream_retry") {
            setStage(`Connection dropped — resuming (try ${ev.attempt})…`);
          } else if (ev.type === "verifying") {
            setStage("Checking that it builds…");
          } else if (ev.type === "fix_error") {
            setStage(`Build failed — fixing (attempt ${ev.attempt})…`);
          } else if (ev.type === "stopped") {
            setStage("Stopping…");
          } else if (ev.type === "error") {
            patchMsg(msgId, (m) => ({
              ...m,
              content: `${m.content}\n\n${ev.message}`.trim(),
            }));
          } else if (ev.type === "done") {
            const status = ev.stopped ? "stopped" : ev.verified === false ? "failed" : "done";
            patchMsg(msgId, (m) => ({
              ...m,
              status,
              credits: ev.credits,
              durationMs: ev.durationMs,
              sha: ev.sha ?? null,
              // The saved reply when the server sends it (it may have finished before we were listening).
              content:
                typeof ev.content === "string" && ev.content.trim()
                  ? ev.content
                  : ev.stopped && m.content
                    ? `${m.content}\n\n*Stopped.*`
                    : m.content,
            }));
            setStage(null);
            putLive(null);
            // A new content hash means a new immutable preview URL.
            setPreview((u) => u.replace(/sha=[^&]*/, `sha=${ev.sha ?? "new"}`));
            setDraftsVersion((v) => v + 1);
            void refreshFiles();
            if (notify && document.hidden) {
              try {
                new Notification(status === "done" ? `${brand.shortName} finished` : `${brand.shortName} ${status}`, {
                  body: name,
                  tag: `forge-${projectId}`,
                });
              } catch {}
            }
          }
        }
      }
    },
    [patchMsg, refreshFiles, notify, name, projectId, brand.shortName, putLive, flushStream, soon],
  );

  // Follow turns one at a time, in order. Browsers cap open connections per
  // host, so streams for every queued turn at once would starve other requests.
  const followingRef = useRef<string | null>(null);
  const [followTick, setFollowTick] = useState(0);
  useEffect(() => {
    if (followingRef.current) return;
    const next = messages.find(
      (m) => m.role === "assistant" && m.buildId && (m.status === "queued" || m.status === "running"),
    );
    if (!next?.buildId) return;
    followingRef.current = next.buildId;
    void follow(next.id, next.buildId)
      .catch((e) =>
        patchMsg(next.id, (m) => ({
          ...m,
          status: "failed",
          content: `${m.content}\n\n${e instanceof Error ? e.message : "Lost the build stream"}`.trim(),
        })),
      )
      .finally(() => {
        followingRef.current = null;
        flushStream();
        setStage(null);
        setFollowTick((t) => t + 1);
      });
  }, [messages, followTick, follow, patchMsg, flushStream]);

  // A prompt typed on the dashboard starts the first build on arrival.
  useEffect(() => {
    const seed = sessionStorage.getItem(`seed:${projectId}`);
    if (seed) {
      sessionStorage.removeItem(`seed:${projectId}`);
      // Files attached on the dashboard were uploaded to this project already.
      let files: Attachment[] = [];
      try {
        files = JSON.parse(sessionStorage.getItem(`seedFiles:${projectId}`) ?? "[]") as Attachment[];
      } catch {}
      sessionStorage.removeItem(`seedFiles:${projectId}`);
      // Started from IOTx Home in Plan mode: the first turn is a plan.
      const seedMode = sessionStorage.getItem(`seedMode:${projectId}`) === "plan" ? ("plan" as Mode) : undefined;
      sessionStorage.removeItem(`seedMode:${projectId}`);
      if (seedMode) setMode("plan");
      void send(seed, seedMode, files);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function openPath(path: string, line?: number) {
    const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const d = (await res.json()) as { path: string; content: string };
      setOpenFile({ path: d.path, content: d.content, rev: Date.now(), line: line ?? null });
      setCodeDraft(null);
      setCodeSaving("idle");
      setTab("code");
    }
  }

  async function saveCode() {
    if (!openFile || codeDraft === null) return;
    setCodeSaving("saving");
    const res = await fetch(`/api/projects/${projectId}/files`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: openFile.path, content: codeDraft }),
    });
    if (res.ok) {
      setOpenFile({ ...openFile, content: codeDraft });
      setCodeDraft(null);
      setCodeSaving("saved");
      setDraftsVersion((v) => v + 1);
    } else {
      setCodeSaving("error");
    }
  }

  async function stopRunning() {
    const target = runningMsg ?? messages.find((m) => m.role === "assistant" && m.status === "queued");
    if (!target?.buildId) return;
    setStage("Stopping…");
    await fetch(`/api/builds/${target.buildId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }).catch(() => undefined);
  }

  async function queueAction(body: Record<string, unknown>) {
    await fetch(`/api/projects/${projectId}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }

  async function toggleNotify() {
    if (notify) {
      setNotify(false);
      try {
        localStorage.setItem("forge:notify", "off");
      } catch {}
      return;
    }
    const perm = await Notification.requestPermission().catch(() => "denied" as const);
    const on = perm === "granted";
    setNotify(on);
    try {
      localStorage.setItem("forge:notify", on ? "on" : "off");
    } catch {}
  }

  /** The user message a reply answers, for "Rerun build". */
  function promptFor(msg: Msg) {
    const i = messages.findIndex((m) => m.id === msg.id);
    for (let j = i - 1; j >= 0; j--) if (messages[j].role === "user") return messages[j];
    return null;
  }

  // Plan replies in this chat are numbered, each with the previous version to compare against.
  const planVersions = new Map<string, { version: number; previous: string | null }>();
  {
    let prev: string | null = null;
    let n = 0;
    for (const m of messages) {
      if (m.role === "assistant" && m.mode === "plan" && m.status === "done" && m.content.trim()) {
        planVersions.set(m.id, { version: ++n, previous: prev });
        prev = m.content;
      }
    }
  }
  // The latest finished build that wrote files: the Code tab marks them and diffs against before it.
  const lastBuild = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.status === "done" && m.sha && m.files.some((f) => f.startsWith("write:"))) {
        const paths = m.files.filter((f) => f.startsWith("write:")).map((f) => f.slice(6));
        return { sha: m.sha, paths: paths.filter((p, j) => paths.indexOf(p) === j) };
      }
    }
    return null;
  })();
  // While a build runs: a first build shows the building view until the app can render
  // (the dev server is up and a page or component exists), then the live preview with a
  // slim bar; a follow-up build keeps the live preview (it hot-reloads) with the bar.
  const buildRunning = kind !== "canvas" && runningMsg && runningMsg.mode !== "ask" && runningMsg.mode !== "plan" ? runningMsg : null;
  const peeked = !!buildRunning && peekBuild === (buildRunning.buildId ?? buildRunning.id);
  const wroteUi = !!buildRunning?.files.some((f) => /^write:src\/((pages|components)\/.+|App)\.[jt]sx?$/.test(f));
  const firstRun = !!buildRunning && firstBuild.current.on;
  const buildView = !buildRunning ? null : firstRun && !peeked && !(sandbox.status === "ready" && wroteUi) ? "overlay" : "bar";
  const liveForBuild = buildRunning && liveCode?.msgId === buildRunning.id ? liveCode : null;
  const lastWrite = buildRunning ? [...buildRunning.files].reverse().find((f) => f.startsWith("write:"))?.slice(6) : undefined;
  const buildActivity =
    liveForBuild && !liveForBuild.done
      ? `${files.includes(liveForBuild.path) ? "Editing" : "Creating"} ${liveForBuild.path}`
      : lastWrite
        ? `Edited ${lastWrite}`
        : null;
  const latestChangeId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.sha && (m.status === "done" || m.status === "failed"))?.id;

  // Queued turns in order, for the toolbar's queue view.
  const queuedTurns = messages.flatMap((m, i) =>
    m.role === "assistant" && m.status === "queued" && m.buildId ? [{ buildId: m.buildId, text: messages[i - 1]?.content ?? "" }] : [],
  );
  const actions: MessageActions = {
    onOpenPath: openPath,
    onFeedback: async (msg, value) => {
      patchMsg(msg.id, (m) => ({
        ...m,
        feedback: m.feedback === value ? null : value,
      }));
      await fetch(`/api/messages/${msg.id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      }).catch(() => undefined);
    },
    onUndo: async (msg, action) => {
      if (!msg.buildId) return;
      const res = await fetch(`/api/projects/${projectId}/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buildId: msg.buildId, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(body.error ?? "That didn't work.");
        return;
      }
      patchMsg(msg.id, (m) => ({ ...m, undone: body.undone }));
      reloadPreview();
      void refreshFiles();
      setDraftsVersion((v) => v + 1);
    },
    onBookmark: async (msg) => {
      const name = window.prompt("Bookmark name", promptFor(msg)?.content.slice(0, 60) ?? "Bookmark");
      if (!name) return;
      await fetch(`/api/projects/${projectId}/bookmarks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha: msg.sha, name }),
      }).catch(() => undefined);
    },
    onRerun: (msg) => {
      const original = promptFor(msg);
      if (original) void send(original.content, (msg.mode as Mode) ?? "build", original.attachments ?? []);
    },
    onAnswer: (text) => void send(text, "build"),
    onSwitchToBuild: (change) => {
      setMode("build");
      void send(`Switched to Build mode. Go ahead and make the change${change ? `: ${change}` : "."}`, "build");
    },
    onApprovePlan: (plan) => void send(`Implement this approved plan. Follow it step by step.\n\n${plan}`, "build"),
    onRevisePlan: () => {
      setMode("plan");
      window.dispatchEvent(new CustomEvent("forge:compose", { detail: "Revise the plan: " }));
    },
    onRunNow: async (buildId) => {
      await fetch(`/api/builds/${buildId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run_now" }),
      }).catch(() => undefined);
      // Show it next in line straight away; the server agrees.
      setMessages((all) => {
        const idx = all.findIndex((m) => m.buildId === buildId);
        if (idx < 1) return all;
        const pair = all.slice(idx - 1, idx + 1);
        const rest = all.filter((_, i) => i !== idx - 1 && i !== idx);
        const firstQueued = rest.findIndex((m) => m.role === "assistant" && m.status === "queued");
        if (firstQueued < 1) return all;
        return [...rest.slice(0, firstQueued - 1), ...pair, ...rest.slice(firstQueued - 1)];
      });
    },
    onMove: async (buildId, by) => {
      // Queued turns run in this order; swap the message pair with its neighbour.
      const queued = messages.filter((m) => m.role === "assistant" && m.status === "queued" && m.buildId).map((m) => m.buildId!);
      const at = queued.indexOf(buildId);
      const to = at + by;
      if (at < 0 || to < 0 || to >= queued.length) return;
      const order = [...queued];
      [order[at], order[to]] = [order[to], order[at]];
      const res = await fetch(`/api/projects/${projectId}/queue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reorder", order }),
      });
      if (!res.ok) return;
      setMessages((all) => {
        const pairs = order.map((id) => {
          const i = all.findIndex((m) => m.buildId === id);
          return [all[i - 1], all[i]];
        });
        const first = all.findIndex((m) => m.buildId === queued[0]) - 1;
        const rest = all.filter((m) => !pairs.some(([u, a]) => m === u || m === a));
        return [...rest.slice(0, first), ...pairs.flat(), ...rest.slice(first)];
      });
    },
    onRemove: async (buildId) => {
      const res = await fetch(`/api/builds/${buildId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove" }),
      });
      if (!res.ok) return;
      setMessages((all) => {
        const idx = all.findIndex((m) => m.buildId === buildId);
        return idx < 0 ? all : all.filter((_, i) => i !== idx && i !== idx - 1);
      });
    },
    onEditQueued: async (buildId, content) => {
      const res = await fetch(`/api/builds/${buildId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) return;
      setMessages((all) => {
        const idx = all.findIndex((m) => m.buildId === buildId);
        return all.map((m, i) => (i === idx - 1 ? { ...m, content } : m));
      });
    },
  };
  actionsRef.current = actions;

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const firstAssistant = messages.find((m) => m.role === "assistant");
  const intents: Intent[] = building
    ? []
    : [
        ...(lastAssistant?.status === "failed"
          ? [
              {
                label: "Try to fix",
                run: () => void send("The last build failed. Read the errors and fix them.", "build"),
              },
            ]
          : []),
        { label: "Visual edit", run: () => toggleInspect() },
        {
          label: "Edit title & description",
          run: () =>
            void send(
              "Improve the page title and meta description in index.html for search and social sharing, based on what the app does.",
              "build",
            ),
        },
        {
          label: "Edit favicon",
          run: () =>
            void send(
              "Create a favicon that fits the app's design with generate_image (square, transparent PNG, saved as public/favicon.png) and link it in index.html.",
              "build",
            ),
        },
        {
          label: "Security review",
          run: () =>
            void send(
              "Review the app for security problems: exposed secrets, unsafe HTML, missing input validation, insecure links. Explain what you find and fix it.",
              "build",
            ),
        },
        {
          label: "Get more visitors",
          run: () =>
            void send(
              "Improve SEO: semantic headings, descriptive alt text, Open Graph and Twitter tags, a sitemap-friendly structure, and fast-loading images.",
              "build",
            ),
        },
      ];

  return (
    <main className="app-editor relative flex min-w-0 flex-1 flex-col">
      <CleanupBanner projectId={projectId} canAnswer={access === "admin"} />
      {draftNotice && !draftNoticeHidden && (
        <div role="status" className="flex items-center gap-2 border-b bg-sky-500/[.08] px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">{draftNotice}</span>
          <button onClick={() => setDraftNoticeHidden(true)} className="rounded px-2 py-0.5 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
            Dismiss
          </button>
        </div>
      )}
      <SurveyPopover />
      <ShareDialog
        projectId={projectId}
        projectName={projectName}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onPublish={async (audience) => {
          setShareOpen(false);
          await fetch(`/api/projects/${projectId}/publish`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audience }),
          }).catch(() => undefined);
          setPublishOpen(true);
        }}
      />
      <HistoryPanel
        projectId={projectId}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onReverted={(sha) => {
          setPreview((u) => u.replace(/sha=[^&]*/, `sha=${sha}`));
          void refreshFiles();
        }}
      />
      <TaskPanel open={tasksOpen} tasks={tasks} onClose={() => setTasksOpen(false)} />
      <PublishDialog
        projectId={projectId}
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onInfo={onPublishInfo}
        refreshKey={changeKey + draftsVersion}
        onFix={(message) => void send(message, "build")}
      />
      {navOpen && sidebar && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setNavOpen(false)}>
          <div className="absolute inset-0 bg-black/20" aria-hidden />
          <div
            className="relative flex h-full shadow-2xl"
            style={{ background: "var(--shell)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {sidebar}
          </div>
        </div>
      )}

      <header className="flex h-12 shrink-0 items-center gap-2 px-2">
        <div className={`flex min-w-0 items-center gap-0.5 ${chatHidden ? "" : "w-[412px] shrink-0"}`}>
          {sidebar && (
            <IconButton label="Open sidebar" onClick={() => setNavOpen(true)}>
              <PanelLeft className="h-4 w-4" />
            </IconButton>
          )}
          <EmojiPicker projectId={projectId} value={emoji} onChange={setEmoji} />
          <h1 className="min-w-0 truncate text-sm font-medium">{name}</h1>
          <ProjectMenu projectId={projectId} name={name} onRenamed={setName} initialIsTemplate={initialIsTemplate} />
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <PresenceBar projectId={projectId} />
            <IconButton
              label={notify ? "Notifications on — click to turn off" : "Notify me when the agent finishes"}
              pressed={notify}
              onClick={toggleNotify}
            >
              {notify ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </IconButton>
            <IconButton label="Task list" onClick={() => setTasksOpen(true)}>
              <ListChecks className="h-4 w-4" />
              {tasks.length > 0 && (
                <span className="ml-0.5 text-[11px] tabular-nums">
                  {tasks.filter((t) => t.status === "done").length}/{tasks.length}
                </span>
              )}
            </IconButton>
            <IconButton label="Show history" onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" />
            </IconButton>
            <IconButton label={chatHidden ? "Show chat panel" : "Hide chat panel"} onClick={() => setChatHidden((h) => !h)}>
              {chatHidden ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </IconButton>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-0.5" role="tablist">
            {(kind === "canvas" ? (["preview", "files"] as Tab[]) : (["preview", "files", "code"] as Tab[])).filter(tabAllowed).map((t) => (
              <TabButton key={t} active={tab === t} onClick={() => setTab(t)}>
                {t === "preview" && kind === "canvas" ? "Canvas" : t}
              </TabButton>
            ))}
            {MORE_TABS.includes(tab) && (
              <TabButton active onClick={() => setTab(tab)}>
                {tab}
              </TabButton>
            )}
            <div className="relative">
              <button
                onClick={() => setMoreOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                className="flex h-7 items-center gap-0.5 rounded-lg px-2 text-[13px] hover:bg-black/[.05] dark:hover:bg-white/[.06]"
                style={{ color: "var(--muted)" }}
              >
                More <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {moreOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} aria-hidden />
                  <div role="menu" className="absolute left-0 top-full z-40 mt-1 w-44 rounded-xl border p-1 shadow-xl" style={{ background: "var(--panel)" }}>
                    {(kind === "canvas" ? (["notes", "settings"] as Tab[]) : MORE_TABS).filter(tabAllowed).map((t) => (
                      <button
                        key={t}
                        role="menuitem"
                        onClick={() => {
                          setTab(t);
                          setMoreOpen(false);
                        }}
                        className={`flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[13px] capitalize hover:bg-black/[.05] dark:hover:bg-white/[.06] ${tab === t ? "font-medium" : ""}`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {tab === "preview" && kind !== "canvas" && (
            <div className="flex min-w-0 items-center gap-0.5 border-l pl-2">
              <DevicePicker device={device} landscape={landscape} onDevice={setDevice} onRotate={() => setLandscape((l) => !l)} />
              <IconButton
                label={`Preview theme: ${theme}`}
                onClick={() => setTheme((t) => (t === "auto" ? "light" : t === "light" ? "dark" : "auto"))}
              >
                {theme === "dark" ? <Moon className="h-4 w-4" /> : theme === "light" ? <Sun className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
              </IconButton>
              <IconButton label="Refresh" onClick={reloadPreview}>
                <RotateCw className="h-4 w-4" />
              </IconButton>
              <IconButton
                label="Full screen (Esc to leave)"
                onClick={() => void frameRef.current?.requestFullscreen?.().catch(() => {})}
              >
                <Expand className="h-4 w-4" />
              </IconButton>
              <IconButton
                label="Open the preview in a new browser tab"
                onClick={() => {
                  // The live preview's own address (with its pass on the server); the bundled preview otherwise.
                  const url = sandbox.status === "ready" && sandbox.url ? sandbox.url : preview;
                  if (url) window.open(url, "_blank", "noopener");
                }}
              >
                <ExternalLink className="h-4 w-4" />
              </IconButton>
            </div>
          )}

          {kind !== "canvas" && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => setShareOpen(true)}
                className="h-7 rounded-lg border px-2.5 text-[13px] transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                style={{ background: "var(--panel)" }}
              >
                Share
              </button>
              {published && (
                <a
                  href={published}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-7 items-center rounded-lg px-2 text-[13px] transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                  style={{ color: "var(--muted)" }}
                >
                  View live
                </a>
              )}
              {perms.can("builder.publish") && (
                <button
                  onClick={() => setPublishOpen(true)}
                  className={`h-7 rounded-lg px-3 text-[13px] font-medium ${publishInfo?.upToDate ? "border" : "btn-primary"}`}
                  style={publishInfo?.upToDate ? { background: "var(--panel)" } : undefined}
                >
                  {publishLabel(publishInfo, false)}
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 pb-2 pr-2">
      {/* Chat */}
      <section className={`w-[420px] shrink-0 flex-col ${chatHidden ? "hidden" : "flex"}`}>

        <ChatSwitcher projectId={projectId} chatId={chatId} canEdit={access !== "view"} />
        <DraftBar
          projectId={projectId}
          version={draftsVersion}
          onChanged={() => {
            // Switching or accepting changes the working tree the preview serves.
            // The container frame is keyed on its URL, which does not change, so
            // it is reloaded directly rather than relying on file-watch timing.
            reloadPreview();
            void refreshFiles();
          }}
        />
        <VariantsBar
          projectId={projectId}
          version={draftsVersion}
          onChanged={() => {
            setDraftsVersion((v) => v + 1);
            reloadPreview();
            void refreshFiles();
          }}
        />

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
          onMouseUp={() => {
            const sel = window.getSelection();
            const text = sel?.toString().trim() ?? "";
            const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
            if (!sel || !text || text.length > 2000 || !node?.closest("[data-agent-message]")) return setReplyPick(null);
            const r = sel.getRangeAt(0).getBoundingClientRect();
            setReplyPick({ text, x: r.left + r.width / 2, y: r.top });
          }}
          onScroll={() => replyPick && setReplyPick(null)}
        >
          {messages.map((m, i) => {
            const next = messages[i + 1];
            return (
              <MessageItem
                key={m.id}
                files={files}
                msg={m}
                projectId={projectId}
                stage={m.status === "running" ? stage : null}
                live={liveCode?.msgId === m.id ? liveCode : null}
                canViewCode={perms.can("builder.code.view")}
                latestWithChanges={m.id === latestChangeId}
                plan={planVersions.get(m.id)}
                isLast={m.id === lastAssistant?.id}
                firstGeneration={m.id === firstAssistant?.id}
                queuedBuildId={
                  m.role === "user" && next?.role === "assistant" && next.status === "queued" ? next.buildId : undefined
                }
                actions={stableActions}
              />
            );
          })}
          {runningMsg && <Tips onTry={(p) => void send(p, "build")} />}
          {historyError && (
            <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm">
              <p className="font-medium">Couldn&apos;t load your chat history.</p>
              <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
                Your project and its messages are safe. Check your connection and try again.
              </p>
              <button onClick={() => window.location.reload()} className="mt-2 rounded-md border px-2.5 py-1 text-xs">
                Retry
              </button>
            </div>
          )}
          {messages.length === 0 && !historyError && (
            <div className="text-sm" style={{ color: "var(--muted)" }}>
              <p>Describe a change and it will be built.</p>
              {access !== "view" && (
                <button
                  onClick={() =>
                    void send(
                      "I'm new here. Onboard me: ask what I want to build and who it's for, then suggest a first version and how to get there.",
                      "ask",
                    )
                  }
                  className="mt-3 rounded-lg border px-3 py-1.5 text-xs hover:bg-black/[.03]"
                  style={{ color: "var(--fg, inherit)" }}
                >
                  New here? Let {brand.shortName} onboard you
                </button>
              )}
            </div>
          )}
        </div>

        {health && health.open.length > 0 && access !== "view" && (
          <button
            onClick={() => setTab("health")}
            className="mx-3 mb-1 flex items-center justify-between rounded-lg border px-3 py-1.5 text-left text-xs hover:bg-black/[.03]"
          >
            <span>
              <span className="font-medium">Monitoring brief:</span> {health.open.length}{" "}
              {health.open.length === 1 ? "issue" : "issues"} found
              {health.open.some((f) => f.severity === "critical") ? ", including critical" : ""}
            </span>
            <span style={{ color: "var(--muted)" }}>Review →</span>
          </button>
        )}
        {voiceOpen && (
          <VoiceSession
            projectId={projectId}
            onClose={() => setVoiceOpen(false)}
            onSendToChat={async (text, mode) => {
              // "Applying quick edit": the selected element changes instantly; otherwise it goes to the agent.
              if (mode === "quick_edit" && selected) {
                await fetch(`/api/projects/${projectId}/quick-edit`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    action: "edit",
                    instruction: text,
                    selector: selected.selector,
                    text: selected.text,
                  }),
                }).catch(() => undefined);
                return;
              }
              void send(text, mode === "ask" ? "ask" : "build");
            }}
          />
        )}
        {access === "view" ? (
          <ViewOnlyBar projectId={projectId} />
        ) : (
          <>
          <TeamUpCard doneTurns={messages.filter((m) => m.status === "done").length} />
          <DailyIdeaCard
            projectId={projectId}
            show={messages.some((m) => m.role === "assistant" && m.status === "done") && !messages.some((m) => m.status === "running" || m.status === "queued")}
            onSend={(text) => void send(text)}
          />
          {replyPick && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuote((q) => ({ text: replyPick.text, n: (q?.n ?? 0) + 1 }));
                setReplyPick(null);
                window.getSelection()?.removeAllRanges();
              }}
              className="fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg border px-2.5 py-1 text-xs font-medium shadow-lg"
              style={{ left: replyPick.x, top: replyPick.y - 6, background: "var(--panel)" }}
            >
              Reply
            </button>
          )}
          <ChatComposer
            quote={quote}
            preattach={preattach}
            projectId={projectId}
            onVariants={async (text) => {
              const res = await fetch(`/api/projects/${projectId}/variants`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "create", prompt: text, count: 3 }),
              });
              const d = await res.json().catch(() => ({}));
              if (!res.ok) return d.error ?? "Couldn't start variants.";
              // The variant turns were queued server-side; reload to show them.
              window.location.reload();
              return null;
            }}
            files={files}
            mode={mode}
            setMode={setMode}
            building={building}
            queuedCount={queuedCount}
            paused={paused}
            intents={intents}
            selectedLabel={selected?.selector ?? null}
            onClearSelected={() => setSelected(null)}
            onSend={(text, attachments) => void send(text, undefined, attachments)}
            onStop={stopRunning}
            onTogglePause={async () => {
              const next = !paused;
              setPaused(next);
              await queueAction({ action: next ? "pause" : "resume" });
            }}
            onClearQueue={async () => {
              await queueAction({ action: "clear" });
            }}
            onTalk={() => setVoiceOpen(true)}
            onOpen={(panel) => {
              if (panel === "history") setHistoryOpen(true);
              else if (panel === "tasks") setTasksOpen(true);
              else setTab(panel);
            }}
          />
          </>
        )}
      </section>

      {/* Workspace */}
      <section
        className={`relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border shadow-sm ${chatHidden ? "ml-2" : ""}`}
        style={{ background: "var(--bg)" }}
      >
        {tab === "preview" && kind !== "canvas" && (sandbox.status === "ready" || sandbox.status === "failed") && (
          <div
            role="toolbar"
            aria-label="Preview interactions"
            className={`absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border p-1 shadow-lg ${dock.at === "top" ? "top-3" : "bottom-3"} ${drawing ? "hidden" : ""}`}
            style={{ background: "var(--panel)" }}
          >
            {dock.min ? (
              <IconButton label="Show preview tools" onClick={() => setDockSaved({ ...dock, min: false })}>
                <Maximize2 className="h-4 w-4" />
              </IconButton>
            ) : (
            <>
            <IconButton label="Select elements" pressed={inspecting} onClick={toggleInspect}>
              <MousePointer2 className="h-4 w-4" />
            </IconButton>
            <IconButton
              label="Edit text inline"
              pressed={textEditing}
              onClick={() => {
                const next = !textEditing;
                setTextEditing(next);
                frameRef.current?.contentWindow?.postMessage({ source: "forge-editor", type: "textedit", enabled: next }, "*");
              }}
            >
              <Type className="h-4 w-4" />
            </IconButton>
            <IconButton label="Add a comment" pressed={commenting} onClick={toggleCommenting}>
              <MessageSquare className="h-4 w-4" />
            </IconButton>
            <IconButton
              label={`Comments${unreadThreads ? `, ${unreadThreads} unread` : ""}`}
              pressed={commentsOpen}
              onClick={() => setCommentsOpen((o) => !o)}
            >
              <span className="text-[12px] font-medium">All</span>
              {unreadThreads > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#6d4aff]" aria-hidden />}
            </IconButton>
            {queuedTurns.length > 0 && (
              <div className="relative">
                <IconButton label={`Queue, ${queuedTurns.length} waiting`} pressed={queueOpen} onClick={() => setQueueOpen((o) => !o)}>
                  <ListOrdered className="h-4 w-4" />
                  <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-[#6d4aff] px-0.5 text-[9px] font-semibold text-white">
                    {queuedTurns.length}
                  </span>
                </IconButton>
                {queueOpen && (
                  <div
                    role="dialog"
                    aria-label="Queued messages"
                    className={`absolute left-1/2 z-30 w-72 -translate-x-1/2 rounded-xl border p-2 text-xs shadow-xl ${dock.at === "top" ? "top-full mt-2" : "bottom-full mb-2"}`}
                    style={{ background: "var(--panel)" }}
                  >
                    <p className="px-1 pb-1 font-medium">Up next</p>
                    <ol className="space-y-1">
                      {queuedTurns.map((q, i) => (
                        <li key={q.buildId} className="flex items-center gap-1.5 rounded-lg px-1 py-1 hover:bg-black/[.04] dark:hover:bg-white/[.05]">
                          <span className="w-4 shrink-0 text-right" style={{ color: "var(--muted)" }}>{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate" title={q.text}>{q.text}</span>
                          <button onClick={() => actions.onRunNow(q.buildId)} title="Run now" className="rounded px-1 hover:underline">
                            Run
                          </button>
                          <button onClick={() => actions.onRemove(q.buildId)} title="Remove from queue" className="rounded px-1 text-red-500 hover:underline">
                            ×
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
            <IconButton label="Draw on the preview" pressed={drawing} onClick={() => setDrawing(true)}>
              <PencilLine className="h-4 w-4" />
            </IconButton>
            <span className="mx-0.5 h-5 w-px bg-black/10 dark:bg-white/10" aria-hidden />
            <IconButton
              label={dock.at === "top" ? "Move toolbar to the bottom" : "Move toolbar to the top"}
              onClick={() => setDockSaved({ ...dock, at: dock.at === "top" ? "bottom" : "top" })}
            >
              {dock.at === "top" ? <ArrowDownToLine className="h-4 w-4" /> : <ArrowUpToLine className="h-4 w-4" />}
            </IconButton>
            <IconButton label="Minimise preview tools" onClick={() => setDockSaved({ ...dock, min: true })}>
              <Minimize2 className="h-4 w-4" />
            </IconButton>
            </>
            )}
          </div>
        )}

        {tab === "preview" && kind === "canvas" && (
          <div
            className="pointer-events-auto absolute bottom-3 right-3 z-20 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] shadow-sm"
            style={{ background: "var(--panel)", color: "var(--muted)" }}
            title="Select, Edit text and Draw work on app previews"
          >
            <MousePointer2 className="h-3.5 w-3.5" /> Visual edits: Unavailable on Canvas for now
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden" style={{ background: "var(--bg)" }}>
          {tab === "preview" && buildRunning && buildView === "overlay" && (
            <BuildOverlay
              key={buildRunning.id}
              stage={stage}
              steps={buildRunning.files ?? []}
              name={name}
              first={firstRun}
              onPeek={() => setPeekBuild(buildRunning.buildId ?? buildRunning.id)}
              code={liveForBuild?.content ? { path: liveForBuild.path, content: liveForBuild.content, writing: !liveForBuild.done } : null}
            />
          )}
          {tab === "preview" && buildRunning && buildView === "bar" && (
            <BuildBar
              key={buildRunning.id}
              stage={stage}
              activity={buildActivity}
              onShowOverlay={firstRun && peeked && !(sandbox.status === "ready" && wroteUi) ? () => setPeekBuild(null) : undefined}
            />
          )}
          {tab === "preview" && kind === "canvas" && <CanvasEditor projectId={projectId} projectName={name} />}
          {tab === "preview" && kind !== "canvas" && sandbox.status === "booting" && (
            <PreviewBooting projectId={projectId} />
          )}
          {tab === "preview" && sandbox.status === "paused" && <PreviewPaused onResume={bootSandbox} />}
          {tab === "preview" && sandbox.status === "stopped" && <PreviewStopped onStart={bootSandbox} />}
          {tab === "preview" && sandbox.status === "crashed" && (
            <PreviewCrashed projectId={projectId} restarting={crashRestarting} onRestart={bootSandbox} />
          )}

          {tab === "preview" && sandbox.status === "failed" && (
            <div className="h-full overflow-auto p-6">
              <p className="text-sm font-medium">The dev server did not start</p>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Showing the bundled preview instead.
              </p>
              {sandbox.error && (
                <pre
                  className="mt-3 max-h-40 overflow-auto rounded-lg border p-3 font-mono text-[11px]"
                  style={{ color: "var(--muted)" }}
                >
                  {sandbox.error.slice(0, 1200)}
                </pre>
              )}
              <button onClick={bootSandbox} className="mt-3 rounded-lg border px-3 py-1.5 text-xs">
                Retry
              </button>
            </div>
          )}

          {tab === "preview" && (sandbox.status === "ready" || sandbox.status === "failed") && (
            // Desktop fills the panel edge to edge, like Lovable; fixed sizes sit framed in the middle.
            <div className={`relative grid h-full place-items-center ${device.w ? "p-4" : ""}`}>
              <iframe
                key={sandbox.url ?? preview}
                ref={frameRef}
                onLoad={postPins}
                src={sandbox.url ?? preview}
                title="App preview"
                // Generated code is untrusted. The dev sandbox runs on its own
                // origin (127.0.0.1:<port>), so it may keep its own storage
                // (localStorage, cookies) without reaching the editor's. The
                // bundled fallback is served from the editor's origin, so it
                // never gets allow-same-origin.
                sandbox={
                  sandbox.url
                    ? "allow-scripts allow-forms allow-popups allow-modals allow-same-origin"
                    : "allow-scripts allow-forms allow-popups allow-modals"
                }
                // Phones and tablets get device chrome (a bezel around the exact screen size).
                className={`bg-white transition-all ${
                  device.id === "phone"
                    ? "rounded-[44px] border-[11px] border-zinc-900 shadow-2xl ring-1 ring-zinc-700"
                    : device.id === "tablet"
                      ? "rounded-[30px] border-[14px] border-zinc-900 shadow-2xl ring-1 ring-zinc-700"
                      : device.w
                        ? "rounded-xl border shadow-sm"
                        : ""
                }`}
                style={{
                  ...frameSize(device, landscape),
                  boxSizing: device.id === "phone" || device.id === "tablet" ? "content-box" : undefined,
                  maxWidth: "100%",
                  maxHeight: "100%",
                  colorScheme: theme === "auto" ? "normal" : theme,
                }}
              />
              {drawing && (
                <DrawOverlay
                  projectId={projectId}
                  onAttach={(att) => setPreattach([att])}
                  onClose={() => setDrawing(false)}
                />
              )}
              {selected && !commentsOpen && (
                <QuickEditBar
                  projectId={projectId}
                  selected={selected}
                  runtimeError={runtimeError?.message ?? null}
                  onAskAgent={(instruction) => void send(instruction, "design")}
                  onClose={() => setSelected(null)}
                  onOpenCode={(file, line) => void openPath(file, line)}
                />
              )}
              {pendingText.length > 0 && (
                <PendingTextBar
                  projectId={projectId}
                  changes={pendingText}
                  onSent={() => setPendingText([])}
                  onDiscard={() => {
                    setPendingText([]);
                    reloadPreview();
                  }}
                />
              )}
              {commentsOpen && (
                <CommentsPanel
                  projectId={projectId}
                  pending={pendingPin}
                  onPendingDone={() => setPendingPin(null)}
                  activeId={activeThread}
                  setActiveId={setActiveThread}
                  missing={missingPins}
                  onThreads={setThreads}
                  onSendToChat={(t) => {
                    setSelected({
                      selector: t.selector ?? "",
                      path: t.locator ?? "",
                      text: t.elementText ?? "",
                    });
                    const thread = [t, ...t.replies].map((c) => `${c.author.name}: ${c.body}`).join("\n");
                    void send(`Address this comment on ${t.selector ?? "the page"}:\n\n${thread}`, "build");
                  }}
                  onClose={() => setCommentsOpen(false)}
                />
              )}
              {runtimeError && !building && (
                <div
                  role="alert"
                  className="absolute bottom-6 left-1/2 flex w-[min(560px,calc(100%-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl border bg-white p-3 shadow-lg dark:bg-zinc-900"
                >
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">The preview hit an error</p>
                    <p
                      className="mt-0.5 line-clamp-2 break-words font-mono text-[11px]"
                      style={{ color: "var(--muted)" }}
                    >
                      {runtimeError.message}
                    </p>
                    {!!device.w && device.w < 600 && (
                      <p className="mt-1.5 text-[11px]">
                        It crashed at phone size. Try opening it in your browser, or ask the agent to optimize it for mobile.{" "}
                        {sandbox.url && (
                          <a href={sandbox.url} target="_blank" rel="noreferrer" className="underline">
                            Open in browser
                          </a>
                        )}{" "}
                        <button
                          onClick={() =>
                            void send(
                              "The app crashes on a phone-sized screen (" + device.w + "px wide) with: " + runtimeError.message + "\n\nOptimize it for mobile: fix the crash, then check every page at 375px wide for overflow, tiny tap targets and layouts that break.",
                              "build",
                            )
                          }
                          className="underline"
                        >
                          Optimize for mobile
                        </button>
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setRuntimeError(null)}
                    className="shrink-0 rounded-md px-2 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                    style={{ color: "var(--muted)" }}
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() =>
                      void send(
                        "Fix this error from the preview:\n\n" +
                          runtimeError.message +
                          (runtimeError.stack ? "\n\n" + runtimeError.stack : ""),
                        "build",
                        [],
                        { freeFix: true },
                      )
                    }
                    title="Free, up to 5 fixes a day"
                    className="shrink-0 rounded-md bg-[#6d4aff] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Try to fix
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === "files" && <LibraryPanel projectId={projectId} onOpenFile={(p) => void openPath(p)} />}

          {tab === "security" && (
            <SecurityCenter
              projectId={projectId}
              onFixQueued={(f) =>
                setMessages((m) => [
                  ...m,
                  {
                    id: f.userMessageId,
                    role: "user",
                    content: f.prompt,
                    files: [],
                    mode: "build",
                  },
                  {
                    id: f.messageId,
                    role: "assistant",
                    content: "",
                    files: [],
                    mode: "build",
                    status: "queued",
                    buildId: f.buildId,
                  },
                ])
              }
            />
          )}

          {tab === "terminal" && access !== "view" && <TerminalPanel projectId={projectId} />}
          {tab === "artifacts" && (
            <ArtifactsPanel key={artifactId ?? "list"} projectId={projectId} initialId={artifactId} onSend={(t) => void send(t, "build")} />
          )}
          {tab === "notes" && <NotesPanel projectId={projectId} readOnly={access === "view"} />}
          {tab === "grow" && <MarketingPanel projectId={projectId} onSend={(t, m) => void send(t, m)} />}
          {tab === "design" && (
            <DesignSystemPanel projectId={projectId} onChanged={reloadPreview} onSend={(t) => void send(t, "build")} />
          )}
          {tab === "cloud" && <CloudPanel projectId={projectId} onSend={(t) => void send(t, "build")} />}
          {tab === "browser" && <BrowserPanel projectId={projectId} />}

          {tab === "health" && (
            <HealthPanel
              projectId={projectId}
              onFixQueued={(f) =>
                setMessages((m) => [
                  ...m,
                  {
                    id: f.userMessageId,
                    role: "user",
                    content: f.prompt,
                    files: [],
                    mode: "build",
                  },
                  {
                    id: f.messageId,
                    role: "assistant",
                    content: "",
                    files: [],
                    mode: "build",
                    status: "queued",
                    buildId: f.buildId,
                  },
                ])
              }
            />
          )}

          {tab === "settings" && (
            <ProjectSettings
              projectId={projectId}
              subdomain={subdomain}
              initialDomain={customDomain}
              publishedUrl={published}
              onSend={(t) => void send(t, "build")}
            />
          )}

          {tab === "code" && (
            <CodePane
              projectId={projectId}
              files={files}
              openFile={openFile}
              draft={codeDraft}
              canEdit={perms.can("builder.code.edit")}
              building={building}
              saving={codeSaving}
              lastBuild={lastBuild}
              onOpen={(f) => void openPath(f)}
              onDraft={(t) => {
                setCodeDraft(t);
                setCodeSaving("idle");
              }}
              onSave={() => void saveCode()}
            />
          )}
        </div>
      </section>
      </div>
    </main>
  );
}

/** Lovable-style tabs live under More; Preview, Files and Code stay visible. */
/** The live status line for the tool the agent has just started. */
const ACTIVITY: Record<string, string> = {
  write_file: "Writing a file…",
  delete_file: "Deleting a file…",
  read_file: "Reading a file…",
  edit_image: "Editing an image…",
  generate_image: "Generating an image…",
  read_preview_logs: "Reading the preview's logs…",
  ask_questions: "Preparing questions for you…",
  update_tasks: "Updating the task list…",
  memorize: "Saving to project memory…",
  update_memory: "Updating project memory…",
  forget_memory: "Updating project memory…",
  search_company_knowledge: "Searching company knowledge…",
  suggest_knowledge_update: "Suggesting a knowledge update…",
  run_command: "Running a command…",
  view_app: "Looking at the app…",
  turn_report: "Writing the summary…",
  save_attachment: "Saving your attachment…",
  read_project: "Reading another project…",
  read_collection: "Reading a collection…",
  use_library: "Adding a library…",
  list_libraries: "Looking at libraries…",
  read_archive: "Reading an archive…",
  import_archive: "Importing an archive…",
  enable_cloud: "Setting up the backend…",
  create_migration: "Changing the database…",
  query_database: "Querying the database…",
  set_table_access: "Setting table access…",
  create_storage_bucket: "Creating file storage…",
  test_function: "Testing a backend function…",
  schedule_job: "Scheduling a job…",
  browser_open: "Opening the app in a browser…",
  browser_act: "Clicking through the app…",
  browser_read: "Reading the page…",
  browser_login: "Signing in to the app…",
  test_user: "Creating a test user…",
  http_request: "Calling an API…",
  connector_request: "Calling a connector…",
  list_connectors: "Checking connectors…",
  mcp_list_tools: "Checking connected tools…",
  mcp_call: "Using a connected tool…",
  create_project: "Creating a project…",
  create_visual: "Making a visual…",
  create_document: "Writing a document…",
  web_search: "Searching the web…",
  web_fetch: "Reading a web page…",
};
const activityLabel = (tool: string) => ACTIVITY[tool] ?? `Using ${tool.replace(/_/g, " ")}…`;

const MORE_TABS: Tab[] = ["design", "cloud", "browser", "grow", "notes", "artifacts", "terminal", "security", "health", "settings"];

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`h-7 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-[13px] capitalize transition-colors ${
        active ? "bg-black/[.07] font-medium dark:bg-white/[.1]" : "hover:bg-black/[.04] dark:hover:bg-white/[.06]"
      }`}
      style={active ? undefined : { color: "var(--muted)" }}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`relative flex h-7 min-w-7 items-center justify-center rounded-lg px-1.5 transition-colors ${
        pressed ? "bg-black/[.08] dark:bg-white/[.12]" : "hover:bg-black/[.05] dark:hover:bg-white/[.06]"
      }`}
      style={{ color: pressed ? "var(--text)" : "var(--muted)" }}
    >
      {children}
    </button>
  );
}
