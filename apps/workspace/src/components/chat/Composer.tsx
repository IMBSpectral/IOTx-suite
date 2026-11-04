"use client";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { AtSign, Bold, Clock, Code, Italic, Link2, List, ListOrdered, Mic, Paperclip, Quote, Send, Smile, SquareCode, Strikethrough, Type, X } from "lucide-react";
import { api, suiteAt } from "@/lib/client";
import EmojiPicker from "./EmojiPicker";
import { noteEmoji, searchEmoji } from "./emoji";
import { fmtSize, laterOptions, localInput, type ChatFile, type Group, type Person } from "./types";

export type ComposerHandle = { addFiles: (files: File[]) => void; focus: () => void; insert: (s: string) => void };
export type SendOpts = { mentions: string[]; fileIds: string[]; alsoChannel: boolean };

export const COMMANDS = [
  { name: "topic", hint: "[text]", desc: "Set the channel topic" },
  { name: "invite", hint: "@person", desc: "Add people to this channel" },
  { name: "leave", hint: "", desc: "Leave this channel" },
  { name: "mute", hint: "", desc: "Mute or unmute this channel" },
  { name: "remind", hint: "[text] in 20 minutes", desc: "Remind yourself (saved for later)" },
  { name: "away", hint: "", desc: "Set yourself as away" },
  { name: "active", hint: "", desc: "Set yourself as active" },
  { name: "dnd", hint: "[minutes]", desc: "Pause notifications" },
  { name: "status", hint: "[emoji] [text]", desc: "Set your status" },
  { name: "catchup", hint: "", desc: "AI summary of what you missed" },
  { name: "shrug", hint: "[text]", desc: "Append ¯\\_(ツ)_/¯" },
  { name: "me", hint: "[text]", desc: "Say it in italics" },
];

type Pending = ChatFile & { uploading?: boolean; error?: string; key: string };

export default function Composer({
  ref, channelId, parentId, placeholder, people, groups, meId, draftKey, disabled, broadcast = true, showAlsoChannel, flash,
  onSend, onSchedule, onEditLast, onCommand, extraCommands = [],
}: {
  ref?: Ref<ComposerHandle>;
  channelId: string; parentId?: string; placeholder: string; people: Person[]; groups: Group[]; meId: string; draftKey: string; disabled?: string;
  broadcast?: boolean; showAlsoChannel?: boolean; flash: (m: string) => void;
  onSend: (body: string, opts: SendOpts) => Promise<boolean>;
  onSchedule: (body: string, fileIds: string[], at: Date) => Promise<boolean>;
  onEditLast?: () => void;
  onCommand?: (name: string, arg: string) => Promise<boolean>;
  extraCommands?: { name: string; hint: string; desc: string }[];
}) {
  const storeKey = `iotx.chat.draft.${draftKey}`;
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [tools, setTools] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [sched, setSched] = useState(false);
  const [custom, setCustom] = useState("");
  const [also, setAlso] = useState(false);
  const [sel, setSel] = useState(0);
  const [caret, setCaret] = useState(0);
  const [rec, setRec] = useState<{ start: number; r: MediaRecorder; chunks: Blob[]; cancel?: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  // Drafts survive switching channels and reloads.
  useEffect(() => {
    try {
      setText(localStorage.getItem(storeKey) ?? "");
    } catch {
      setText("");
    }
    setFiles([]);
    setMentions([]);
  }, [storeKey]);
  useEffect(() => {
    try {
      if (text) localStorage.setItem(storeKey, text);
      else localStorage.removeItem(storeKey);
    } catch {}
  }, [text, storeKey]);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [rec]);

  const upload = async (list: File[]) => {
    for (const f of list.slice(0, 10 - files.length)) {
      const key = `${Date.now()}-${Math.random()}`;
      setFiles((xs) => [...xs, { id: "", name: f.name, type: f.type, size: f.size, uploading: true, key }]);
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await fetch(`/workspace/api/chat/channels/${channelId}/files`, { method: "POST", body: fd });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Upload failed");
        setFiles((xs) => xs.map((x) => (x.key === key ? { ...d.file, key } : x)));
      } catch (e) {
        setFiles((xs) => xs.map((x) => (x.key === key ? { ...x, uploading: false, error: (e as Error).message } : x)));
      }
    }
  };
  const dropFile = (p: Pending) => {
    setFiles((xs) => xs.filter((x) => x.key !== p.key));
    if (p.id) api(`/chat/files/${p.id}`, { method: "DELETE" }).catch(() => {});
  };

  useImperativeHandle(ref, () => ({
    addFiles: (fs: File[]) => void upload(fs),
    focus: () => ta.current?.focus(),
    insert: (s: string) => {
      setText((t) => (t ? `${t}${t.endsWith(" ") || t.endsWith("\n") ? "" : " "}${s}` : s));
      ta.current?.focus();
    },
  }));

  useEffect(() => {
    if (!suiteAt()) return;
    const w = window as unknown as { __iotxMentionLocal?: () => { title: string; items: { label: string; sub?: string; insert: string }[] } };
    w.__iotxMentionLocal = () => ({
      title: "This chat",
      items: [
        ...(broadcast ? [{ label: "@here", sub: "Everyone here who's online", insert: "@here" }, { label: "@channel", sub: "Everyone in this channel", insert: "@channel" }] : []),
        ...groups.map((g) => ({ label: `@${g.handle}`, sub: `${g.name} · ${g.memberIds.length} people`, insert: `@${g.handle}` })),
      ],
    });
    return () => {
      delete w.__iotxMentionLocal;
    };
  }, [groups, broadcast]);

  // What the caret is in: @mention, :emoji, or a /command.
  const before = text.slice(0, caret);
  // In the suite, its global @ picker takes over; this composer's groups and @channel show there under "This page".
  const at = suiteAt() ? null : /(^|\s)@([\w.-]*)$/.exec(before);
  const colon = /(^|\s):([a-z0-9_+-]{2,})$/i.exec(before);
  const slash = /^\/(\w*)$/.exec(text.trim()) && onCommand ? /^\/(\w*)$/.exec(text.trim()) : null;
  type Sugg = { key: string; label: string; sub?: string; apply: () => void };
  let sugg: Sugg[] = [];
  const replaceTail = (re: RegExp, s: string) => {
    const head = before.replace(re, (_m, sp) => `${sp}${s}`);
    const next = head + text.slice(caret);
    setText(next);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(head.length, head.length);
      setCaret(head.length);
    });
  };
  if (at) {
    const t = at[2].toLowerCase();
    const ppl = people.filter((p) => p.id !== meId && (p.name.toLowerCase().includes(t) || p.email.toLowerCase().startsWith(t))).slice(0, 6);
    sugg = [
      ...ppl.map((p) => ({ key: p.id, label: p.name, sub: p.email, apply: () => { replaceTail(/(^|\s)@([\w.-]*)$/, `@${p.name} `); setMentions((m) => [...new Set([...m, p.id])]); } })),
      ...groups.filter((g) => g.handle.startsWith(t)).slice(0, 3).map((g) => ({ key: g.id, label: `@${g.handle}`, sub: `${g.name} · ${g.memberIds.length} people`, apply: () => replaceTail(/(^|\s)@([\w.-]*)$/, `@${g.handle} `) })),
      ...(broadcast ? [["channel", "Notify everyone in this channel"], ["here", "Notify everyone online"]] : []).filter(([h]) => h.startsWith(t)).map(([h, d]) => ({ key: h, label: `@${h}`, sub: d, apply: () => replaceTail(/(^|\s)@([\w.-]*)$/, `@${h} `) })),
    ];
  } else if (colon) {
    sugg = searchEmoji(colon[2], 8).map((x) => ({ key: x.n, label: `${x.e}  :${x.n}:`, apply: () => { noteEmoji(x.e); replaceTail(/(^|\s):([a-z0-9_+-]{2,})$/i, `${x.e} `); } }));
  } else if (slash) {
    sugg = [...COMMANDS, ...extraCommands].filter((c) => c.name.startsWith(slash[1].toLowerCase())).map((c) => ({ key: c.name, label: `/${c.name} ${c.hint}`, sub: c.desc, apply: () => { setText(`/${c.name} `); setCaret(c.name.length + 2); ta.current?.focus(); } }));
  }
  const selIdx = Math.min(sel, Math.max(0, sugg.length - 1));

  const wrap = (a: string, b = a, placeholderText = "text") => {
    const el = ta.current;
    if (!el) return;
    const s = el.selectionStart, e = el.selectionEnd;
    const mid = text.slice(s, e) || placeholderText;
    const next = text.slice(0, s) + a + mid + b + text.slice(e);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + a.length, s + a.length + mid.length);
    });
  };
  const prefixLines = (fn: (i: number) => string) => {
    const el = ta.current;
    if (!el) return;
    const s = text.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const e0 = text.indexOf("\n", el.selectionEnd);
    const e = e0 < 0 ? text.length : e0;
    const block = text.slice(s, e).split("\n").map((l, i) => fn(i) + l).join("\n");
    setText(text.slice(0, s) + block + text.slice(e));
    requestAnimationFrame(() => el.focus());
  };
  const link = () => wrap("[", "](https://)", "link text");

  const ready = files.filter((f) => f.id && !f.uploading);
  const busy = files.some((f) => f.uploading);
  const go = async () => {
    const body = text.trim();
    if ((!body && !ready.length) || sending || busy || disabled) return;
    if (body.startsWith("/") && onCommand) {
      const m = /^\/(\w+)\s*([\s\S]*)$/.exec(body);
      if (m) {
        let out = m[2];
        if (m[1] === "shrug") out = `${m[2]} ¯\\_(ツ)_/¯`.trim();
        else if (m[1] === "me") out = `_${m[2]}_`;
        else {
          setSending(true);
          const done = await onCommand(m[1].toLowerCase(), m[2].trim());
          setSending(false);
          if (done) {
            setText("");
            return;
          }
          flash(`/${m[1]} isn't a command. Type / to see them.`);
          return;
        }
        setText(out);
        return sendBody(out);
      }
    }
    return sendBody(body);
  };
  const sendBody = async (body: string) => {
    setSending(true);
    const ok = await onSend(body, { mentions: mentions.filter((id) => body.includes(`@${people.find((p) => p.id === id)?.name}`)), fileIds: ready.map((f) => f.id), alsoChannel: also });
    setSending(false);
    if (ok) {
      setText("");
      setMentions([]);
      setFiles([]);
      setAlso(false);
    }
  };
  const schedule = async (when: Date) => {
    const body = text.trim();
    setSched(false);
    if (!body && !ready.length) return flash("Write a message to schedule first.");
    if (await onSchedule(body, ready.map((f) => f.id), when)) {
      setText("");
      setFiles([]);
      setMentions([]);
    }
  };

  const startRec = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return flash("Your browser can't record audio.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      const state = { start: Date.now(), r, chunks: [] as Blob[], cancel: false };
      r.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRec(null);
        if (state.cancel || !state.chunks.length) return;
        const type = r.mimeType || "audio/webm";
        const file = new File(state.chunks, `Voice message ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).replace(":", ".")}.${type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"}`, { type });
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/workspace/api/chat/channels/${channelId}/files`, { method: "POST", body: fd });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return flash(d.error ?? "Couldn't send the voice message.");
        await onSend("", { mentions: [], fileIds: [d.file.id], alsoChannel: false });
      };
      r.start();
      setRec(state);
    } catch {
      flash("Allow the microphone to record a voice message.");
    }
  };
  const secs = rec ? Math.floor((Date.now() - rec.start) / 1000) + tick * 0 : 0;

  if (disabled) return <div className="ch-join"><span>{disabled}</span></div>;
  return (
    <div className={`ch-composer2${tools ? " tools" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); }}>
      {sugg.length > 0 && (
        <div className="suggest ch-sugg" role="listbox">
          {sugg.map((s, i) => (
            <button key={s.key} type="button" role="option" aria-selected={i === selIdx} className={i === selIdx ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={s.apply}>
              {s.label} {s.sub && <span className="ws-muted">{s.sub}</span>}
            </button>
          ))}
        </div>
      )}
      {tools && (
        <div className="ch-fmtbar" role="toolbar" aria-label="Formatting">
          <button type="button" className="ix-iconbtn" onClick={() => wrap("*")} title="Bold (Ctrl+B)" aria-label="Bold"><Bold size={15} /></button>
          <button type="button" className="ix-iconbtn" onClick={() => wrap("_")} title="Italic (Ctrl+I)" aria-label="Italic"><Italic size={15} /></button>
          <button type="button" className="ix-iconbtn" onClick={() => wrap("~")} title="Strikethrough (Ctrl+Shift+X)" aria-label="Strikethrough"><Strikethrough size={15} /></button>
          <button type="button" className="ix-iconbtn" onClick={link} title="Link" aria-label="Link"><Link2 size={15} /></button>
          <span className="sep" />
          <button type="button" className="ix-iconbtn" onClick={() => prefixLines(() => "- ")} title="Bulleted list" aria-label="Bulleted list"><List size={15} /></button>
          <button type="button" className="ix-iconbtn" onClick={() => prefixLines((i) => `${i + 1}. `)} title="Numbered list" aria-label="Numbered list"><ListOrdered size={15} /></button>
          <button type="button" className="ix-iconbtn" onClick={() => prefixLines(() => "> ")} title="Quote" aria-label="Quote"><Quote size={15} /></button>
          <span className="sep" />
          <button type="button" className="ix-iconbtn" onClick={() => wrap("`")} title="Code" aria-label="Code"><Code size={15} /></button>
          <button type="button" className="ix-iconbtn" onClick={() => wrap("```\n", "\n```", "code")} title="Code block (Ctrl+Alt+Shift+C)" aria-label="Code block"><SquareCode size={15} /></button>
        </div>
      )}
      {files.length > 0 && (
        <div className="ch-pending">
          {files.map((f) => (
            <span key={f.key} className={`ch-pfile${f.error ? " err" : ""}`} title={f.error ?? f.name}>
              {f.type.startsWith("image/") && f.id ? <img src={`/workspace/api/chat/files/${f.id}`} alt="" /> : <Paperclip size={13} />}
              <span className="nm">{f.name}</span>
              <small className="ws-muted">{f.uploading ? "Uploading…" : f.error ? f.error : fmtSize(f.size)}</small>
              <button type="button" className="ix-iconbtn" onClick={() => dropFile(f)} aria-label={`Remove ${f.name}`}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {rec ? (
        <div className="ch-rec">
          <span className="dot" /> Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          <span style={{ flex: 1 }} />
          <button type="button" className="ws-btn" onClick={() => { rec.cancel = true; rec.r.stop(); }}>Cancel</button>
          <button type="button" className="ws-btn primary" onClick={() => rec.r.stop()}>Send</button>
        </div>
      ) : (
        <textarea ref={ta} rows={1} placeholder={placeholder} value={text} aria-label={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setSel(0);
            if (Date.now() - lastTyping.current > 3000 && e.target.value.trim() && !e.target.value.startsWith("/")) {
              lastTyping.current = Date.now();
              api(`/chat/channels/${channelId}`, { body: { action: "typing", parentId } }).catch(() => {});
            }
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onPaste={(e) => {
            const fs = [...e.clipboardData.files];
            if (fs.length) {
              e.preventDefault();
              upload(fs);
            }
          }}
          onKeyDown={(e) => {
            if (sugg.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); return setSel((selIdx + 1) % sugg.length); }
              if (e.key === "ArrowUp") { e.preventDefault(); return setSel((selIdx - 1 + sugg.length) % sugg.length); }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return sugg[selIdx].apply(); }
              if (e.key === "Escape") { e.preventDefault(); return setCaret(-1); }
            }
            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); return wrap("*"); }
            if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); return wrap("_"); }
            if (mod && e.shiftKey && e.key.toLowerCase() === "x") { e.preventDefault(); return wrap("~"); }
            if (mod && e.altKey && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); return wrap("```\n", "\n```", "code"); }
            if (e.key === "ArrowUp" && !text && onEditLast) { e.preventDefault(); return onEditLast(); }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              go();
            }
          }} />
      )}
      <div className="ch-cbar">
        <button type="button" className="ix-iconbtn" onClick={() => fileIn.current?.click()} title="Attach files" aria-label="Attach files"><Paperclip size={16} /></button>
        <input ref={fileIn} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload([...e.target.files]); e.target.value = ""; }} />
        <button type="button" className={`ix-iconbtn${tools ? " on" : ""}`} onClick={() => setTools(!tools)} title="Formatting" aria-label="Show formatting" aria-pressed={tools}><Type size={16} /></button>
        <span className="ch-emoji-wrap">
          <button type="button" className="ix-iconbtn" onClick={() => setEmoji(!emoji)} title="Emoji" aria-label="Emoji"><Smile size={16} /></button>
          {emoji && <EmojiPicker align="left" onClose={() => setEmoji(false)} onPick={(x) => { setEmoji(false); setText((t) => t + x); ta.current?.focus(); }} />}
        </span>
        <button type="button" className="ix-iconbtn" onClick={() => { setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@`); ta.current?.focus(); setCaret(text.length + 2); }} title="Mention someone" aria-label="Mention someone"><AtSign size={16} /></button>
        <button type="button" className="ix-iconbtn" onClick={startRec} disabled={!!rec} title="Record a voice message" aria-label="Record a voice message"><Mic size={16} /></button>
        {showAlsoChannel && (
          <label className="ch-also"><input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} /> Also send to channel</label>
        )}
        <span style={{ flex: 1 }} />
        <span className="ch-sendgrp">
          <button type="button" className="ix-send" onClick={go} disabled={(!text.trim() && !ready.length) || sending || busy} aria-label="Send"><Send size={16} /></button>
          <button type="button" className="ch-sched-btn" onClick={() => { setSched(!sched); setCustom(localInput(new Date(Date.now() + 3600_000))); }} disabled={!text.trim() && !ready.length} title="Schedule for later" aria-label="Schedule message"><Clock size={14} /></button>
          {sched && (
            <div className="ch-menu ch-sched" role="menu">
              <b>Schedule message</b>
              {laterOptions().map((o) => <button key={o.label} type="button" role="menuitem" onClick={() => schedule(o.at)}>{o.label} <small className="ws-muted">{o.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</small></button>)}
              <div className="ws-row" style={{ flexWrap: "nowrap", padding: "6px 8px" }}>
                <input type="datetime-local" className="ws-input" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom time" />
                <button type="button" className="ws-btn primary" onClick={() => custom && schedule(new Date(custom))}>Set</button>
              </div>
            </div>
          )}
        </span>
      </div>
    </div>
  );
}
