"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePerms } from "./PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { Icon } from "./icons";
import { startBuild } from "./appearance-client";

export type AskMode = "chat" | "plan" | "build";

/**
 * The 2-in-1 prompt (AI Chat; the start page itself is StartPage.tsx): the same AI box for everyone. Chat is always there;
 * Plan and Build appear only when the person's role has the Builder switch
 * (and Plan / Build mode) on. Chat opens a conversation with IOTx; Plan and
 * Build start a project and hand the first turn to the builder.
 */
export function AskBox({
  initial = "",
  placeholder,
  onChat,
  defaultMode,
  autoFocus,
}: {
  initial?: string;
  placeholder?: string;
  onChat: (text: string) => void;
  defaultMode?: AskMode;
  autoFocus?: boolean;
}) {
  const perms = usePerms();
  const brand = useBrand();
  const router = useRouter();
  const canBuild = perms.builder && perms.can("builder.build") && perms.can("builder.project.create");
  const canPlan = perms.builder && perms.can("builder.plan") && perms.can("builder.project.create");
  const modes: AskMode[] = ["chat", ...(canPlan ? (["plan"] as const) : []), ...(canBuild ? (["build"] as const) : [])];
  const [mode, setMode] = useState<AskMode>(defaultMode && modes.includes(defaultMode) ? defaultMode : canBuild ? "build" : "chat");
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    const fill = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; mode?: AskMode }>).detail;
      setText(d.text);
      if (d.mode && modes.includes(d.mode)) setMode(d.mode);
      requestAnimationFrame(() => box.current?.focus());
    };
    window.addEventListener("iotx:ask", fill);
    return () => window.removeEventListener("iotx:ask", fill);
  });

  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    setError(null);
    if (mode === "chat") {
      onChat(t);
      setText("");
      return;
    }
    setBusy(true);
    const err = await startBuild(t, mode, (h) => router.push(h));
    if (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!perms.can("home.ask") && !canBuild) {
    return (
      <div className="ix-prompt" style={{ padding: 16, color: "var(--ix-muted)" }}>
        Asking {brand.shortName} isn&apos;t turned on for your role. Your apps are below.
      </div>
    );
  }

  const label: Record<AskMode, string> = { chat: "Chat", plan: "Plan", build: "Build" };
  const hint: Record<AskMode, string> = {
    chat: "Ask and discuss. Nothing gets built.",
    plan: "Start a new app with a plan you approve first",
    build: "Start building a new app right away",
  };
  return (
    <div className="ix-prompt">
      <textarea
        ref={box}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder ?? (modes.length > 1 ? `Ask ${brand.shortName} or describe what you want to build…` : `Ask ${brand.shortName} anything…`)}
        aria-label={`Ask ${brand.shortName}`}
      />
      <div className="ix-prompt-bar">
        {modes.length > 1 ? (
          <span className="ix-modes" role="group" aria-label="Mode">
            {modes.map((m) => (
              <button key={m} className="ix-tool" aria-pressed={mode === m} onClick={() => setMode(m)} title={hint[m]} data-mode={m}>
                <Icon name={m === "chat" ? "chat" : m === "plan" ? "plan" : "builder"} size={13} />
                {label[m]}
              </button>
            ))}
          </span>
        ) : (
          <span className="ix-hint" style={{ padding: "0 6px" }} title="An admin can turn on Builder for your role to plan and build apps here.">
            Chat with {brand.shortName}
          </span>
        )}
        <span className="ix-hint ix-hide-phone" style={{ marginLeft: 4 }}>
          {hint[mode]}
        </span>
        <button className="ix-send" onClick={() => void submit()} disabled={busy || !text.trim()} aria-label={mode === "chat" ? "Send" : mode === "plan" ? "Plan it" : "Build it"}>
          <Icon name="send" size={16} />
        </button>
      </div>
      {error && (
        <div className="ix-error" style={{ padding: "0 14px 10px" }} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
