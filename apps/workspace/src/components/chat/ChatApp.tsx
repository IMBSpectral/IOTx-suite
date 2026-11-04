"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, Bookmark, ChevronDown, Clock, FolderOpen, Hash, Info, Keyboard, Lock, Pin, Plus, Search, Sparkles, Star, Users, X, Zap } from "lucide-react";
import type { Boot } from "@/lib/page";
import { api, subscribe } from "@/lib/client";
import StartCallButton from "@/components/meet/StartCallButton";
import Composer, { type ComposerHandle, type SendOpts } from "./Composer";
import MessageList, { Avatar, Menu } from "./MessageList";
import Rich from "./Rich";
import { BrowseChannels, ChannelDetails, Confirm, FilesView, GroupsDialog, KeysDialog, MakeTask, NewChannel, NewMessage, PrefsDialog, SavedView, ScheduledView, ShareDialog, Switcher } from "./Panels";
import { AppsDialog, Ephemeral, GuestsDialog, PushToggle, ShortcutDialog, type Shortcut } from "./Apps";
import { msgLink, type Channel, type Group, type Msg, type Prefs, type PresenceMap } from "./types";

type View = "channel" | "search" | "saved" | "scheduled" | "files";
type Typing = Record<string, Record<string, { name: string; until: number; parentId: string | null }>>;

export default function ChatApp({ boot }: { boot: Boot }) {
  const { me, people } = boot;
  const [channels, setChannels] = useState<Channel[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [view, setView] = useState<View>("channel");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [more, setMore] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(true);
  const [unreadAfter, setUnreadAfter] = useState<string | null>(null);
  const [thread, setThread] = useState<{ root: Msg; replies: Msg[] } | null>(null);
  const [summary, setSummary] = useState<{ text: string; busy: boolean } | null>(null);
  const [catchup, setCatchup] = useState<{ text: string; busy: boolean; n?: number } | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Msg[] | null>(null);
  const [pins, setPins] = useState<Msg[] | null>(null);
  const [presence, setPresence] = useState<PresenceMap>({});
  const [prefs, setPrefs] = useState<Prefs>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [typing, setTyping] = useState<Typing>({});
  const [dialog, setDialog] = useState<null | "newCh" | "newMsg" | "browse" | "switcher" | "prefs" | "groups" | "keys" | "guests" | "apps" | { details: string }>(null);
  const [commands, setCommands] = useState<{ name: string; hint: string; desc: string }[]>([]);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [shortcut, setShortcut] = useState<Shortcut | null>(null);
  const [shortcutMenu, setShortcutMenu] = useState(false);
  const [eph, setEph] = useState<{ id: string; channelId: string; text: string; from: string }[]>([]);
  const [share, setShare] = useState<Msg | null>(null);
  const [taskFor, setTaskFor] = useState<Msg | null>(null);
  const [ask, setAsk] = useState<{ text: string; ok: string; run: () => void } | null>(null);
  const [plusMenu, setPlusMenu] = useState(false);
  const [toast, setToast] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [editLast, setEditLast] = useState(0);
  const [editLastT, setEditLastT] = useState(0);
  const [rail, setRail] = useState(false);
  const [now, setNow] = useState(Date.now());
  const curRef = useRef<string | null>(null);
  const threadRef = useRef<string | null>(null);
  const prefsRef = useRef<Prefs>({});
  const chRef = useRef<Channel[]>([]);
  const composer = useRef<ComposerHandle>(null);
  curRef.current = cur;
  threadRef.current = thread?.root.id ?? null;
  prefsRef.current = prefs;
  chRef.current = channels;

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  }, []);
  const name = useCallback((id: string) => (id === me.id ? me.name : people.find((p) => p.id === id)?.name ?? "Someone"), [me, people]);
  const channel = channels.find((c) => c.id === cur);
  const title = useCallback((c: Channel) => (c.kind === "dm" ? (c.dmWithAll.length ? c.dmWithAll.map(name).join(", ") : `${me.name} (you)`) : c.name), [name, me.name]);
  const chanNames = useMemo(() => channels.filter((c) => c.kind !== "dm").map((c) => c.name), [channels]);

  const loadChannels = useCallback(() => api<{ channels: Channel[] }>("/chat/channels").then((d) => { setChannels(d.channels); return d.channels; }), []);
  const loadGroups = useCallback(() => api<{ groups: Group[] }>("/chat/groups").then((d) => setGroups(d.groups)).catch(() => {}), []);
  const loadSaved = useCallback(() => api<{ items: { message: Msg; done: boolean }[] }>("/chat/saved").then((d) => setSaved(Object.fromEntries(d.items.filter((x) => !x.done).map((x) => [x.message.id, true])))).catch(() => {}), []);
  const markRead = useCallback((id: string) => api(`/chat/channels/${id}`, { body: { action: "read" } }).then(() => loadChannels()).catch(() => {}), [loadChannels]);

  const loadMsgs = useCallback(async (id: string, around?: string) => {
    const d = await api<{ messages: Msg[]; more: boolean }>(`/chat/channels/${id}/messages${around ? `?around=${around}` : ""}`);
    if (curRef.current !== id) return;
    setMsgs(d.messages);
    setMore(d.more);
    setLoadingMsgs(false);
    markRead(id);
  }, [markRead]);
  const loadOlder = useCallback(async () => {
    const id = curRef.current;
    if (!id || !msgs.length) return;
    const d = await api<{ messages: Msg[]; more: boolean }>(`/chat/channels/${id}/messages?before=${encodeURIComponent(msgs[0].createdAt)}`);
    if (curRef.current !== id) return;
    setMsgs((xs) => [...d.messages.filter((m) => !xs.some((x) => x.id === m.id)), ...xs]);
    setMore(d.more);
  }, [msgs]);
  const openThread = useCallback(async (rootId: string, chId?: string) => {
    const c = chId ?? curRef.current;
    if (!c) return;
    const d = await api<{ root: Msg; messages: Msg[] }>(`/chat/channels/${c}/messages?thread=${rootId}`);
    setThread({ root: d.root, replies: d.messages });
    setSummary(null);
  }, []);
  const go = useCallback((id: string, opts: { around?: string; thread?: string } = {}) => {
    const c = chRef.current.find((x) => x.id === id);
    setView("channel");
    setResults(null);
    setRail(false);
    setCatchup(null);
    if (id !== curRef.current) {
      setThread(null);
      setPins(null);
      setMsgs([]);
      setLoadingMsgs(true);
      setUnreadAfter(c?.unread ? c.lastReadAt : null);
      curRef.current = id;
      setCur(id);
      loadMsgs(id, opts.around).catch((e) => flash(e.message));
    } else if (opts.around && !msgs.some((m) => m.id === opts.around)) loadMsgs(id, opts.around).catch(() => {});
    if (opts.around) setHighlight(opts.around);
    if (opts.thread) openThread(opts.thread, id).catch(() => {});
  }, [loadMsgs, openThread, flash, msgs]);

  // First load: channels, deep link, presence, groups, saved.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    // A first load during a server restart is retried a few times.
    const first = (n: number): Promise<Channel[]> => loadChannels().catch((e) => (n > 0 ? new Promise((r) => setTimeout(r, 2000)).then(() => first(n - 1)) : Promise.reject(e)));
    first(4).then(async (cs) => {
      chRef.current = cs;
      const want = qs.get("channel");
      const msg = qs.get("message");
      if (!want && msg) {
        const r = await api<{ message: Msg }>(`/chat/messages/${msg}`).catch(() => null);
        if (r) return go(r.message.channelId, { around: r.message.parentId && !r.message.alsoChannel ? r.message.parentId : r.message.id, thread: r.message.parentId ?? undefined });
      }
      const first = (want && cs.find((c) => c.id === want)) || cs.find((c) => c.kind === "public" && c.name === "general") || cs[0];
      if (first) go(first.id, { around: msg && !qs.get("thread") ? msg : undefined, thread: qs.get("thread") ?? undefined });
      if (msg) setHighlight(msg);
    }).catch((e) => flash(e.message));
    api<{ prefs: Prefs; presence: PresenceMap }>("/chat/prefs").then((d) => { setPrefs(d.prefs); setPresence(d.presence); }).catch(() => {});
    loadGroups();
    loadSaved();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Bots' slash commands, and this channel's ⚡ shortcuts.
  const loadCommands = useCallback(() => api<{ commands: { command: string; usage: string; description: string; bot: string }[] }>("/chat/commands").then((d) => setCommands(d.commands.map((x) => ({ name: x.command, hint: x.usage, desc: `${x.description || "Command"} · ${x.bot}` })))).catch(() => {}), []);
  useEffect(() => {
    loadCommands();
  }, [loadCommands]);
  const [appsN, setAppsN] = useState(0);
  useEffect(() => {
    if (!cur) return;
    api<{ workflows: Shortcut[] }>(`/chat/workflows?channelId=${cur}`).then((d) => setShortcuts(d.workflows), () => setShortcuts([]));
  }, [cur, appsN]);

  // Typing indicators expire.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);

  const desktop = useCallback((titleText: string, body: string, onClick: () => void) => {
    const p = prefsRef.current;
    if (!p.desktop || typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
    if (p.dndUntil && new Date(p.dndUntil) > new Date()) return;
    const n = new Notification(titleText, { body: body.slice(0, 180), tag: titleText });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  }, []);

  // Real-time: SSE events for this workspace.
  useEffect(
    () =>
      subscribe((type, d) => {
        if (type === "channel" || type === "read") return void loadChannels();
        if (type === "apps") return void loadCommands();
        if (type === "ephemeral") return setEph((x) => [...x.slice(-4), { id: `${Date.now()}${Math.random()}`, channelId: d.channelId, text: d.text, from: d.from }]);
        if (type === "presence") return setPresence((p) => ({ ...p, [d.userId]: { presence: d.presence, status: d.status, emoji: d.emoji } }));
        if (type === "typing") {
          if (d.userId === me.id) return;
          return setTyping((t) => ({ ...t, [d.channelId]: { ...(t[d.channelId] ?? {}), [d.userId]: { name: d.name, until: Date.now() + 6000, parentId: d.parentId } } }));
        }
        if (type === "notification") {
          const n = d.notification as { title: string; body: string; link: string; kind: string };
          if (["mention", "dm", "reply", "later", "channel"].includes(n.kind)) {
            if (n.kind === "later" || n.kind === "channel") flash(n.title);
            desktop(n.title, n.body, () => {
              const u = new URL(n.link, window.location.origin);
              const ch = u.searchParams.get("channel");
              if (ch) go(ch, { around: u.searchParams.get("message") ?? undefined, thread: u.searchParams.get("thread") ?? undefined });
            });
          }
          return;
        }
        const m = d?.message as Msg | undefined;
        if (!m) return;
        const inList = !m.parentId || m.alsoChannel;
        const upsert = (xs: Msg[]) => (xs.some((x) => x.id === m.id) ? xs.map((x) => (x.id === m.id ? m : x)) : type === "message" ? [...xs, m] : xs);
        if (m.channelId === curRef.current && inList) setMsgs(upsert);
        if (m.parentId && m.parentId === threadRef.current) setThread((t) => (t ? { ...t, replies: upsert(t.replies) } : t));
        if (m.id === threadRef.current) setThread((t) => (t ? { ...t, root: m } : t));
        if (type === "message") {
          setTyping((t) => {
            if (!t[m.channelId]?.[m.userId]) return t;
            const c = { ...t[m.channelId] };
            delete c[m.userId];
            return { ...t, [m.channelId]: c };
          });
          if (m.channelId === curRef.current && document.visibilityState === "visible") markRead(m.channelId);
          else loadChannels();
          // "Every new message" channels pop a desktop notification (mentions and DMs come as notifications above).
          const c = chRef.current.find((x) => x.id === m.channelId);
          if (c && c.kind !== "dm" && c.joined && !c.muted && c.notifyLevel === "all" && m.userId !== me.id && !m.mentions.includes(me.id) && !m.system)
            desktop(`#${c.name}`, `${m.hookName ?? name(m.userId)}: ${m.body || "sent a file"}`, () => go(c.id, { around: m.id }));
        }
      }),
    [loadChannels, loadCommands, markRead, desktop, go, me.id, name, flash],
  );

  const send = async (body: string, o: SendOpts, parentId?: string) => {
    if (!cur) return false;
    try {
      const r = await api<{ message: Msg }>(`/chat/channels/${cur}/messages`, { body: { body, mentions: o.mentions, fileIds: o.fileIds, parentId, alsoChannel: o.alsoChannel } });
      const m = r.message;
      if (!parentId || o.alsoChannel) setMsgs((xs) => (xs.some((x) => x.id === m.id) ? xs : [...xs, m]));
      if (parentId) setThread((t) => (t && !t.replies.some((x) => x.id === m.id) ? { ...t, replies: [...t.replies, m] } : t));
      setUnreadAfter(null);
      if (!channel?.joined) loadChannels();
      return true;
    } catch (e) {
      flash((e as Error).message);
      return false;
    }
  };
  const schedule = async (body: string, fileIds: string[], at: Date, parentId?: string) => {
    if (!cur) return false;
    try {
      await api(`/chat/channels/${cur}/messages`, { body: { body, fileIds, parentId, sendAt: at.toISOString() } });
      flash(`Scheduled for ${at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}. See it under Scheduled.`);
      return true;
    } catch (e) {
      flash((e as Error).message);
      return false;
    }
  };
  const react = (m: Msg, emoji: string) => api(`/chat/messages/${m.id}/reactions`, { body: { emoji } }).catch((e) => flash(e.message));
  const edit = async (m: Msg, body: string) => {
    await api(`/chat/messages/${m.id}`, { method: "PATCH", body: { body } }).catch((e) => flash(e.message));
  };
  const remove = (m: Msg) => setAsk({ text: "Delete this message? This can't be undone.", ok: "Delete", run: () => api(`/chat/messages/${m.id}`, { method: "DELETE" }).catch((e) => flash(e.message)) });
  const showPins = useCallback(async () => {
    if (!curRef.current) return;
    const d = await api<{ pins: Msg[] }>(`/chat/channels/${curRef.current}`);
    setPins(d.pins);
  }, []);
  const pin = async (m: Msg) => {
    await api(`/chat/messages/${m.id}`, { method: "PATCH", body: { pinned: !m.pinned } }).catch((e) => flash(e.message));
    if (pins) showPins();
  };
  const saveMsg = async (m: Msg, remindAt?: Date | null) => {
    try {
      if (remindAt === undefined && saved[m.id]) {
        await api(`/chat/messages/${m.id}/save`, { body: { saved: false } });
        setSaved((s) => ({ ...s, [m.id]: false }));
        return flash("Removed from saved items");
      }
      await api(`/chat/messages/${m.id}/save`, { body: remindAt ? { remindAt: remindAt.toISOString() } : {} });
      setSaved((s) => ({ ...s, [m.id]: true }));
      flash(remindAt ? `I'll remind you ${remindAt.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Saved for later");
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const markUnread = async (m: Msg) => {
    if (!cur) return;
    await api(`/chat/channels/${cur}`, { body: { action: "read", unreadFrom: m.id } }).catch((e) => flash(e.message));
    setUnreadAfter(new Date(new Date(m.createdAt).getTime() - 1).toISOString());
    loadChannels();
    flash("Marked unread from here");
  };
  const copyLink = (m: Msg) => {
    navigator.clipboard?.writeText(msgLink(m)).then(() => flash("Link copied"), () => flash(msgLink(m)));
  };
  const openChannelByName = useCallback((n: string) => {
    const c = chRef.current.find((x) => x.kind !== "dm" && x.name === n);
    if (c) go(c.id);
  }, [go]);
  const openMsg = (m: Msg) => go(m.channelId, { around: m.parentId && !m.alsoChannel ? m.parentId : m.id, thread: m.parentId ?? undefined });
  const summarize = async () => {
    if (!thread) return;
    setSummary({ text: "", busy: true });
    try {
      const r = await api<{ summary: string }>(`/chat/messages/${thread.root.id}/summarize`, { body: {} });
      setSummary({ text: r.summary, busy: false });
    } catch (e) {
      setSummary(null);
      flash((e as Error).message);
    }
  };
  const runCatchup = async () => {
    if (!cur) return;
    setCatchup({ text: "", busy: true });
    try {
      const r = await api<{ summary: string; messages: number }>(`/chat/channels/${cur}/catchup`, { body: {} });
      setCatchup({ text: r.summary, busy: false, n: r.messages });
    } catch (e) {
      setCatchup(null);
      flash((e as Error).message);
    }
  };
  const runSearch = async (e?: React.FormEvent, term = q) => {
    e?.preventDefault();
    if (term.trim().length < 2) return;
    setView("search");
    setResults(null);
    try {
      const d = await api<{ results: Msg[] }>(`/chat/search?q=${encodeURIComponent(term.trim())}`);
      setResults(d.results);
    } catch (err) {
      setResults([]);
      flash((err as Error).message);
    }
  };
  const openDm = async (ids: string[]) => {
    try {
      const r = await api<{ channel: { id: string } }>("/chat/dm", ids.length === 1 && ids[0] !== me.id ? { body: { userId: ids[0] } } : { body: { userIds: ids.filter((x) => x !== me.id) } });
      setDialog(null);
      await loadChannels().then((cs) => (chRef.current = cs));
      go(r.channel.id);
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const join = async () => {
    if (!cur) return;
    await api(`/chat/channels/${cur}`, { body: { action: "join" } }).catch((e) => flash(e.message));
    loadChannels();
  };
  const savePrefs = async (p: Partial<Prefs>) => {
    try {
      const r = await api<{ prefs: Prefs }>("/chat/prefs", { body: p });
      setPrefs(r.prefs);
      setPresence((x) => ({ ...x, [me.id]: { presence: r.prefs.presence ?? "active", status: r.prefs.status ?? "", emoji: r.prefs.emoji ?? "" } }));
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const chPost = async (b: Record<string, unknown>) => {
    if (!cur) return;
    await api(`/chat/channels/${cur}`, { body: b });
    loadChannels();
  };

  /** /commands typed in the composer. Returns false for unknown ones. */
  const command = async (cmd: string, arg: string): Promise<boolean> => {
    try {
      switch (cmd) {
        case "topic":
          await chPost({ action: "topic", topic: arg });
          return true;
        case "invite": {
          const ids = people.filter((p) => new RegExp(`@(${[p.name, p.email.split("@")[0]].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "i").test(arg)).map((p) => p.id);
          if (!ids.length) {
            flash("Name someone, like /invite @Maria");
            return true;
          }
          await chPost({ action: "add", memberIds: ids });
          flash(`Added ${ids.map(name).join(", ")}`);
          return true;
        }
        case "leave":
          await chPost({ action: "leave" });
          flash("You left the channel");
          return true;
        case "mute":
          await chPost({ action: "prefs", muted: !channel?.muted });
          flash(channel?.muted ? "Unmuted" : "Muted");
          return true;
        case "remind": {
          const m = /^(.*?)\s+(?:in\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?)|(tomorrow))\s*$/i.exec(arg);
          if (!m || !m[1].trim()) {
            flash('Try "/remind send the report in 30 minutes" or "… tomorrow"');
            return true;
          }
          const at = m[4] ? (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; })() : new Date(Date.now() + Number(m[2]) * (/^h/i.test(m[3]) ? 3600_000 : 60_000));
          const self = await api<{ channel: { id: string } }>("/chat/dm", { body: { userId: me.id } });
          const r = await api<{ message: Msg }>(`/chat/channels/${self.channel.id}/messages`, { body: { body: `⏰ Reminder: ${m[1].trim()}` } });
          await api(`/chat/messages/${r.message.id}/save`, { body: { remindAt: at.toISOString() } });
          setSaved((s) => ({ ...s, [r.message.id]: true }));
          loadChannels();
          flash(`Okay, I'll remind you ${at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
          return true;
        }
        case "away":
          await savePrefs({ away: true });
          return true;
        case "active":
          await savePrefs({ away: false });
          return true;
        case "dnd": {
          const mins = Number(arg) || 60;
          await savePrefs({ dndUntil: new Date(Date.now() + mins * 60_000).toISOString() });
          flash(`Notifications paused for ${mins} minutes`);
          return true;
        }
        case "status": {
          const em = /^(\p{Extended_Pictographic}️?)\s*/u.exec(arg);
          await savePrefs({ emoji: em?.[1] ?? "", status: arg.slice(em?.[0].length ?? 0) });
          flash(arg ? "Status set" : "Status cleared");
          return true;
        }
        case "catchup":
          if (!me.perms["teamchat.ai"]) flash("Your role doesn't include AI catch-up.");
          else runCatchup();
          return true;
        default:
          if (cur && commands.some((c) => c.name === cmd)) {
            const r = await api<{ ephemeral?: string }>("/chat/commands", { body: { channelId: cur, command: cmd, text: arg } });
            if (r.ephemeral) setEph((x) => [...x.slice(-4), { id: `${Date.now()}`, channelId: cur, text: r.ephemeral!, from: `/${cmd}` }]);
            return true;
          }
      }
    } catch (e) {
      flash((e as Error).message);
      return true;
    }
    return false;
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("switcher");
        return;
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        setDialog("keys");
        return;
      }
      if (dialog || ask || share || taskFor) return;
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const list = [...chRef.current.filter((c) => c.joined && c.starred), ...chRef.current.filter((c) => c.joined && !c.starred && c.kind !== "dm"), ...chRef.current.filter((c) => c.joined && !c.starred && c.kind === "dm")];
        const pool = e.shiftKey ? list.filter((c) => c.unread > 0 || c.id === curRef.current) : list;
        const i = pool.findIndex((c) => c.id === curRef.current);
        const next = pool[(i + (e.key === "ArrowDown" ? 1 : -1) + pool.length) % pool.length];
        if (next && next.id !== curRef.current) go(next.id);
        return;
      }
      if (e.key === "Escape") {
        if (thread) setThread(null);
        else if (view !== "channel") setView("channel");
        else if (curRef.current) {
          markRead(curRef.current);
          setUnreadAfter(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, ask, share, taskFor, thread, view, go, markRead]);

  const joined = channels.filter((c) => c.joined);
  const starred = joined.filter((c) => c.starred);
  const pub = joined.filter((c) => c.kind !== "dm" && !c.starred);
  const dms = joined.filter((c) => c.kind === "dm" && !c.starred).sort((a, b) => b.unread - a.unread);
  const savedCount = Object.values(saved).filter(Boolean).length;
  const typingHere = (parentId: string | null) => Object.entries(typing[cur ?? ""] ?? {}).filter(([, v]) => v.until > now && v.parentId === parentId).map(([, v]) => v.name);
  const myPresence = presence[me.id]?.presence ?? prefs.presence ?? "active";
  const chanItem = (c: Channel) => (
    <button key={c.id} className={`ix-nav${cur === c.id && view === "channel" ? " on" : ""}${c.unread && !c.muted ? " ch-unread" : ""}${c.muted ? " ch-muted" : ""}`} onClick={() => go(c.id)}>
      <span className="ico">
        {c.kind === "dm" ? (c.dmWithAll.length > 1 ? <span className="ch-grpav">{c.dmWithAll.length + 1}</span> : <Avatar id={c.dmWith ?? me.id} name={title(c)} size={20} presence={presence[c.dmWith ?? me.id]?.presence} />) : c.kind === "private" ? <Lock size={14} /> : <Hash size={14} />}
      </span>
      <span className="label">{title(c)}{c.kind === "dm" && c.dmWith && presence[c.dmWith]?.emoji && c.dmWithAll.length === 1 ? ` ${presence[c.dmWith].emoji}` : ""}</span>
      {c.muted && <BellOff size={12} className="ws-muted" />}
      {c.mentions > 0 ? <span className="ws-badge">@{c.mentions}</span> : c.unread > 0 && !c.muted && c.kind === "dm" ? <span className="ws-badge">{c.unread}</span> : null}
    </button>
  );

  const side = (
    <>
      <form className="ws-sidepad" onSubmit={runSearch} style={{ marginBottom: 4 }}>
        <div className="ch-search">
          <Search size={14} />
          <input placeholder="Search (try from:me has:file)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search messages" />
          {q && <button type="button" className="ch-x" onClick={() => { setQ(""); setResults(null); if (view === "search") setView("channel"); }} aria-label="Clear search"><X size={13} /></button>}
        </div>
      </form>
      <nav className="ix-navlist ch-quick">
        <button className={`ix-nav${view === "saved" ? " on" : ""}`} onClick={() => { setView("saved"); setRail(false); }}><span className="ico"><Bookmark size={14} /></span><span className="label">Saved for later</span>{savedCount > 0 && <span className="ch-count">{savedCount}</span>}</button>
        <button className={`ix-nav${view === "scheduled" ? " on" : ""}`} onClick={() => { setView("scheduled"); setRail(false); }}><span className="ico"><Clock size={14} /></span><span className="label">Scheduled</span></button>
        <button className={`ix-nav${view === "files" ? " on" : ""}`} onClick={() => { setView("files"); setRail(false); }}><span className="ico"><FolderOpen size={14} /></span><span className="label">Files</span></button>
      </nav>
      {starred.length > 0 && (
        <>
          <div className="ix-sect">Starred</div>
          <nav className="ix-navlist">{starred.map(chanItem)}</nav>
        </>
      )}
      <div className="ix-sect" style={{ display: "flex", alignItems: "center", position: "relative" }}>
        Channels
        <button className="ix-iconbtn" style={{ width: 22, height: 22, marginLeft: "auto" }} onClick={() => setPlusMenu(!plusMenu)} aria-label="Add channels" aria-haspopup="menu"><Plus size={14} /></button>
        {plusMenu && (
          <Menu onClose={() => setPlusMenu(false)} className="ch-plus">
            {me.perms["teamchat.channel.create"] && <button type="button" role="menuitem" onClick={() => setDialog("newCh")}>Create a channel</button>}
            <button type="button" role="menuitem" onClick={() => setDialog("browse")}>Browse channels</button>
            {!me.guest && <button type="button" role="menuitem" onClick={() => setDialog("groups")}>User groups</button>}
            {!me.guest && <button type="button" role="menuitem" onClick={() => setDialog("apps")}>Apps and workflows</button>}
            {me.perms["teamchat.admin"] && <button type="button" role="menuitem" onClick={() => setDialog("guests")}>Guests</button>}
          </Menu>
        )}
      </div>
      <nav className="ix-navlist">
        {pub.map(chanItem)}
        <button className="ix-nav ch-add" onClick={() => setDialog("browse")}><span className="ico"><Plus size={14} /></span><span className="label">Browse channels</span></button>
      </nav>
      <div className="ix-sect" style={{ display: "flex", alignItems: "center" }}>
        Direct messages
        <button className="ix-iconbtn" style={{ width: 22, height: 22, marginLeft: "auto" }} onClick={() => setDialog("newMsg")} aria-label="New message"><Plus size={14} /></button>
      </div>
      <nav className="ix-navlist">{dms.map(chanItem)}</nav>
      <div className="ch-me">
        <button type="button" className="ch-mebtn" onClick={() => setDialog("prefs")} title="Status and notifications">
          <Avatar id={me.id} name={me.name} size={26} presence={myPresence} />
          <span className="label">{prefs.emoji} {prefs.status || (myPresence === "dnd" ? "Notifications paused" : myPresence === "away" ? "Away" : "Active")}</span>
        </button>
        <button type="button" className="ix-iconbtn" onClick={() => setDialog("keys")} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (Ctrl+/)"><Keyboard size={15} /></button>
      </div>
    </>
  );

  const typingLine = (names: string[]) => (
    <div className="ch-typing" aria-live="polite">{names.length ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? " and others" : ""} ${names.length === 1 ? "is" : "are"} typing…` : " "}</div>
  );
  const listProps = {
    meId: me.id, people, groups, channels: chanNames, name, presence, highlight, canTask: !!me.perms["tasks.create"], admin: !!me.perms["teamchat.admin"], saved,
    onReact: react, onEdit: edit, onDelete: remove, onPin: pin, onTask: setTaskFor, onShare: setShare, onSave: saveMsg, onUnread: markUnread, onCopyLink: copyLink,
    onChannel: openChannelByName, onOpenShared: openMsg,
  };
  const archived = channel && !channel.joined && channel.kind !== "public";
  const otherDm = channel?.kind === "dm" && channel.dmWithAll.length === 1 ? channel.dmWith : null;

  return (
    <div className="ws-app">
      <div className="ch-wrap">
        {rail && <div className="ch-rail-scrim" onClick={() => setRail(false)} aria-hidden />}
        <aside className={`ch-rail${rail ? " open" : ""}`} aria-label="Channels and direct messages">{side}</aside>
        <section className={`ch-main${thread ? " has-thread" : ""}`}
          onDragOver={(e) => { if (view === "channel" && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
          onDrop={(e) => { if (view === "channel" && e.dataTransfer.files.length) { e.preventDefault(); composer.current?.addFiles([...e.dataTransfer.files]); } }}>
          {view === "search" ? (
            <>
              <div className="ws-toolbar"><button className="ch-switch" onClick={() => setRail(true)} aria-label="Channels"><h2>Search: “{q}”</h2><ChevronDown size={15} className="ch-switch-ico" /></button><span style={{ flex: 1 }} /><button className="ws-btn" onClick={() => setView("channel")}>Close</button></div>
              <div className="ch-filters">
                {["from:me", "has:file", "has:link", "is:thread", "is:saved", "has:pin", ...(channel && channel.kind !== "dm" ? [`in:#${channel.name}`] : [])].map((f) => (
                  <button key={f} type="button" className="ix-chip" onClick={() => { const t = q.includes(f) ? q.replace(f, "").trim() : `${q} ${f}`.trim(); setQ(t); runSearch(undefined, t); }}>{q.includes(f) ? "✓ " : ""}{f}</button>
                ))}
              </div>
              <div className="ch-list">
                {results === null ? <div className="ws-empty">Searching…</div> : results.length === 0 && <div className="ws-empty">No messages match. Filters: from:@name, in:#channel, before:/after:/on: YYYY-MM-DD, has:file/image/link/pin/reaction, is:thread/saved.</div>}
                {results?.map((m) => (
                  <button key={m.id} className="ch-result" onClick={() => openMsg(m)}>
                    <small className="ws-muted">{m.channelKind === "dm" ? "Direct message" : `#${m.channelName}`} · {m.hookName ?? name(m.userId)} · {new Date(m.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}{m.parentId ? " · in a thread" : ""}</small>
                    {m.body ? <Rich text={m.body} people={people} groups={groups} meId={me.id} big={false} /> : <span className="ws-muted">{m.files.map((f) => f.name).join(", ")}</span>}
                  </button>
                ))}
              </div>
            </>
          ) : view === "saved" ? (
            <>
              <div className="ws-toolbar"><button className="ch-switch" onClick={() => setRail(true)} aria-label="Channels"><Bookmark size={16} /><h2>Saved for later</h2><ChevronDown size={15} className="ch-switch-ico" /></button></div>
              <SavedView name={name} people={people} groups={groups} meId={me.id} onOpen={openMsg} flash={flash} onChanged={loadSaved} />
            </>
          ) : view === "scheduled" ? (
            <>
              <div className="ws-toolbar"><button className="ch-switch" onClick={() => setRail(true)} aria-label="Channels"><Clock size={16} /><h2>Scheduled messages</h2><ChevronDown size={15} className="ch-switch-ico" /></button></div>
              <ScheduledView flash={flash} onOpenChannel={(id) => go(id)} />
            </>
          ) : view === "files" ? (
            <>
              <div className="ws-toolbar"><button className="ch-switch" onClick={() => setRail(true)} aria-label="Channels"><FolderOpen size={16} /><h2>Files</h2><ChevronDown size={15} className="ch-switch-ico" /></button></div>
              <FilesView name={name} flash={flash} onOpen={async (f) => {
                const r = await api<{ message: Msg }>(`/chat/messages/${f.messageId}`).catch(() => null);
                if (r) openMsg(r.message);
              }} />
            </>
          ) : channel ? (
            <>
              <div className="ws-toolbar ch-head-bar">
                <button className="ch-switch" onClick={() => (window.matchMedia("(max-width: 760px)").matches ? setRail(true) : setDialog({ details: "about" }))} aria-label={`${title(channel)} details`} title="Channel details">
                  {channel.kind === "dm" ? (channel.dmWithAll.length > 1 ? <Users size={16} /> : <Avatar id={channel.dmWith ?? me.id} name={title(channel)} size={24} presence={presence[channel.dmWith ?? me.id]?.presence} />) : channel.kind === "private" ? <Lock size={16} /> : <Hash size={16} />}
                  <h2 style={{ marginLeft: 0 }}>{title(channel)}</h2>
                  <ChevronDown size={15} className="ch-switch-ico" />
                </button>
                <button type="button" className={`ix-iconbtn ch-star${channel.starred ? " on" : ""}`} onClick={() => chPost({ action: "prefs", starred: !channel.starred }).catch((e) => flash(e.message))} aria-label={channel.starred ? "Unstar" : "Star"} title={channel.starred ? "Unstar" : "Star"} disabled={!channel.joined}><Star size={15} /></button>
                {otherDm && presence[otherDm]?.status ? <span className="ws-muted ws-hide-mobile ch-topic">{presence[otherDm].emoji} {presence[otherDm].status}</span>
                  : channel.topic && <button type="button" className="ws-muted ws-hide-mobile ch-topic" onClick={() => setDialog({ details: "about" })}>{channel.topic}</button>}
                <span style={{ flex: 1 }} />
                {channel.kind !== "dm" && (
                  <button type="button" className="ch-facepile ws-hide-mobile" onClick={() => setDialog({ details: "members" })} aria-label={`${channel.memberIds.length} members`} title="Members">
                    {channel.memberIds.slice(0, 3).map((id) => <Avatar key={id} id={id} name={name(id)} size={22} />)}
                    <span>{channel.memberIds.length}</span>
                  </button>
                )}
                {me.perms["teamchat.ai"] && <button className="ws-btn ws-hide-mobile" onClick={runCatchup} disabled={catchup?.busy} title="AI summary of what you missed"><Sparkles size={14} /> {catchup?.busy ? "Reading…" : "Catch up"}</button>}
                {me.perms["meetings.create"] && <StartCallButton channelId={channel.id} />}
                {shortcuts.length > 0 && channel.joined && (
                  <span style={{ position: "relative" }}>
                    <button type="button" className="ix-iconbtn" onClick={() => (shortcuts.length === 1 ? setShortcut(shortcuts[0]) : setShortcutMenu(!shortcutMenu))} aria-label="Workflows" title="Workflows" aria-haspopup="menu"><Zap size={16} /></button>
                    {shortcutMenu && (
                      <Menu onClose={() => setShortcutMenu(false)} className="ch-plus ch-wfmenu">
                        {shortcuts.map((w) => <button key={w.id} type="button" role="menuitem" onClick={() => { setShortcutMenu(false); setShortcut(w); }}><Zap size={13} /> {w.name}</button>)}
                      </Menu>
                    )}
                  </span>
                )}
                <button className={`ix-iconbtn${pins ? " on" : ""}`} onClick={() => (pins ? setPins(null) : showPins())} aria-label="Pinned messages" title="Pinned messages"><Pin size={16} /></button>
                {channel.joined && <button className="ix-iconbtn" onClick={() => setDialog({ details: "settings" })} aria-label="Notification settings" title="Notifications">{channel.muted ? <BellOff size={16} /> : <Bell size={16} />}</button>}
                <button className="ix-iconbtn" onClick={() => setDialog({ details: "about" })} aria-label="Channel details" title="Details"><Info size={16} /></button>
              </div>
              {catchup?.text && (
                <div className="ch-summary ch-catchup"><b><Sparkles size={13} /> Catch up{catchup.n ? ` · ${catchup.n} messages` : ""}</b><button type="button" className="ix-iconbtn" onClick={() => setCatchup(null)} aria-label="Close catch-up"><X size={14} /></button><Rich text={catchup.text} people={people} groups={groups} meId={me.id} big={false} /></div>
              )}
              {pins && (
                <div className="ch-pins">
                  <b className="ws-muted" style={{ fontSize: 12 }}><Pin size={12} /> {pins.length ? `${pins.length} pinned` : "No pinned messages yet. Pin one from its ⋯ menu."}</b>
                  {pins.map((p) => (
                    <button key={p.id} type="button" className="ch-pin" onClick={() => { setPins(null); openMsg(p); }}><b>{p.hookName ?? name(p.userId)}</b> <span className="ch-pin-txt">{p.body || p.files.map((f) => f.name).join(", ")}</span></button>
                  ))}
                </div>
              )}
              {channel.unread > 0 && unreadAfter && (
                <div className="ch-unreadbar">
                  <span>{channel.unread} new {channel.unread === 1 ? "message" : "messages"} since {new Date(unreadAfter).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" onClick={() => document.querySelector(".ch-main .ch-newline")?.scrollIntoView({ block: "center", behavior: "smooth" })}>Jump</button>
                  <button type="button" onClick={() => { markRead(channel.id); setUnreadAfter(null); }}>Mark as read</button>
                </div>
              )}
              <MessageList {...listProps} msgs={msgs} loading={loadingMsgs} unreadAfter={unreadAfter} more={more} onLoadOlder={loadOlder} onThread={(m) => openThread(m.id)} editLast={editLast} />
              <Ephemeral notes={eph.filter((n) => n.channelId === channel.id)} onDismiss={(id) => setEph((x) => x.filter((n) => n.id !== id))} />
              {typingLine(typingHere(null))}
              {archived ? null : channel.joined || channel.kind !== "public" ? (
                <Composer ref={composer} channelId={channel.id} draftKey={channel.id} placeholder={`Message ${channel.kind === "dm" ? title(channel) : `#${channel.name}`}`}
                  people={people.filter((p) => channel.kind === "public" || channel.memberIds.includes(p.id))} groups={groups} meId={me.id} broadcast={channel.kind !== "dm"} flash={flash}
                  onSend={(b, o) => send(b, o)} onSchedule={(b, f, at) => schedule(b, f, at)} onEditLast={() => setEditLast((x) => x + 1)} onCommand={command} extraCommands={commands} />
              ) : (
                <div className="ch-join"><span>You’re viewing #{channel.name}.</span><button className="ws-btn" onClick={() => setDialog({ details: "about" })}>Details</button><button className="ws-btn primary" onClick={join}>Join channel</button></div>
              )}
            </>
          ) : (
            <div className="ws-empty">Pick a channel.</div>
          )}
        </section>
        {thread && view === "channel" && (
          <aside className="ch-thread" aria-label="Thread">
            <div className="ws-toolbar">
              <h2 style={{ marginLeft: 0 }}>Thread</h2>
              {channel && <small className="ws-muted">{channel.kind === "dm" ? title(channel) : `#${channel.name}`}</small>}
              <span style={{ flex: 1 }} />
              {me.perms["teamchat.ai"] && thread.replies.length > 0 && (
                <button className="ws-btn" onClick={summarize} disabled={summary?.busy}><Sparkles size={14} /> {summary?.busy ? "Summarizing…" : "Summarize"}</button>
              )}
              <button className="ix-iconbtn" onClick={() => { setThread(null); setSummary(null); }} aria-label="Close thread"><X size={18} /></button>
            </div>
            {summary?.text && (
              <div className="ch-summary"><b><Sparkles size={13} /> Summary</b><div style={{ whiteSpace: "pre-wrap" }}>{summary.text}</div></div>
            )}
            <MessageList {...listProps} msgs={[thread.root, ...thread.replies]} inThread onThread={() => {}} editLast={editLastT} />
            {typingLine(typingHere(thread.root.id))}
            {channel && (channel.joined || channel.kind !== "public") && (
              <Composer channelId={channel.id} parentId={thread.root.id} draftKey={`${channel.id}:${thread.root.id}`} placeholder="Reply…" showAlsoChannel
                people={people.filter((p) => channel.kind === "public" || channel.memberIds.includes(p.id))} groups={groups} meId={me.id} broadcast={channel.kind !== "dm"} flash={flash}
                onSend={(b, o) => send(b, o, thread.root.id)} onSchedule={(b, f, at) => schedule(b, f, at, thread.root.id)} onEditLast={() => setEditLastT((x) => x + 1)} />
            )}
          </aside>
        )}
      </div>
      {dialog === "newCh" && <NewChannel boot={boot} onClose={() => setDialog(null)} onMade={async (id) => { setDialog(null); chRef.current = await loadChannels(); go(id); }} flash={flash} />}
      {dialog === "newMsg" && <NewMessage boot={boot} presence={presence} onClose={() => setDialog(null)} onOpen={openDm} />}
      {dialog === "browse" && <BrowseChannels onClose={() => { setDialog(null); loadChannels(); }} flash={flash} canCreate={!!me.perms["teamchat.channel.create"]} onCreate={() => setDialog("newCh")}
        onOpen={async (id) => { setDialog(null); chRef.current = await loadChannels(); go(id); }} />}
      {dialog === "switcher" && <Switcher channels={channels} people={people} title={title} presence={presence} meId={me.id} onClose={() => setDialog(null)} onChannel={(id) => { setDialog(null); go(id); }} onPerson={(id) => openDm([id])} />}
      {dialog === "prefs" && <PrefsDialog prefs={prefs} onClose={() => setDialog(null)} onSave={savePrefs} push={<PushToggle flash={flash} />} />}
      {dialog === "guests" && <GuestsDialog channels={channels} onClose={() => { setDialog(null); loadChannels(); }} flash={flash} />}
      {dialog === "apps" && <AppsDialog boot={boot} channels={channels} onClose={() => setDialog(null)} flash={flash} onChanged={() => { loadCommands(); setAppsN((x) => x + 1); }} />}
      {shortcut && channel && <ShortcutDialog wf={shortcut} channelId={channel.id} onClose={() => setShortcut(null)} flash={flash} />}
      {dialog === "groups" && <GroupsDialog boot={boot} groups={groups} onClose={() => setDialog(null)} onChanged={loadGroups} flash={flash} />}
      {dialog === "keys" && <KeysDialog onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && channel && (
        <ChannelDetails channel={channel} boot={boot} presence={presence} tab={dialog.details} onClose={() => setDialog(null)} flash={flash} people={people} name={name}
          onChanged={loadChannels} onLeft={async () => { const cs = await loadChannels(); chRef.current = cs; const g = cs.find((c) => c.kind === "public" && c.name === "general"); if (g) go(g.id); }} />
      )}
      {share && (
        <ShareDialog msg={share} channels={channels} title={title} people={people} groups={groups} meId={me.id} onClose={() => setShare(null)}
          onShare={async (to, comment) => {
            try {
              await api(`/chat/channels/${to}/messages`, { body: { body: comment, sharedId: share.id } });
              flash("Shared");
              return true;
            } catch (e) {
              flash((e as Error).message);
              return false;
            }
          }} />
      )}
      {taskFor && <MakeTask msg={taskFor} onClose={() => setTaskFor(null)} flash={flash} boot={boot} />}
      {ask && <Confirm text={ask.text} ok={ask.ok} onOk={ask.run} onClose={() => setAsk(null)} />}
      {toast && <div className="ws-toast" role="status">{toast}</div>}
    </div>
  );
}
