"use client";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Bell, Bookmark, BookmarkCheck, Copy, Download, EyeOff, FileText, Forward, ListTodo, MessageSquare, MoreHorizontal, Pencil, Pin, Smile, Trash2 } from "lucide-react";
import { colorFor, initials } from "@/lib/client";
import EmojiPicker from "./EmojiPicker";
import Rich from "./Rich";
import { QUICK } from "./emoji";
import { fileUrl, fmtDay, fmtSize, fmtTime, laterOptions, type Group, type Msg, type Person, type PresenceMap, isGuestId } from "./types";

export type ListActions = {
  onReact: (m: Msg, e: string) => void;
  onEdit: (m: Msg, b: string) => Promise<void> | void;
  onDelete: (m: Msg) => void;
  onPin: (m: Msg) => void;
  onThread: (m: Msg) => void;
  onTask: (m: Msg) => void;
  onShare: (m: Msg) => void;
  onSave: (m: Msg, remindAt?: Date | null) => void;
  onUnread: (m: Msg) => void;
  onCopyLink: (m: Msg) => void;
  onChannel: (name: string) => void;
  onOpenShared: (m: Msg) => void;
};

export function Avatar({ id, name, presence, size = 34 }: { id: string; name: string; presence?: string; size?: number }) {
  return (
    <span className="ch-avwrap" style={{ width: size, height: size }}>
      <span className="ix-avatar ch-av" style={{ background: colorFor(id), width: size, height: size, fontSize: size < 26 ? 9 : 12 }}>{initials(name)}</span>
      {presence && <span className={`ch-dot ${presence}`} aria-label={presence === "active" ? "Active" : presence === "dnd" ? "Do not disturb" : "Away"} />}
    </span>
  );
}

export function Files({ m }: { m: Pick<Msg, "files"> }) {
  const [big, setBig] = useState<string | null>(null);
  if (!m.files.length) return null;
  const imgs = m.files.filter((f) => /^image\/(png|jpeg|gif|webp)/.test(f.type));
  const rest = m.files.filter((f) => !imgs.includes(f));
  return (
    <div className="ch-files">
      {imgs.length > 0 && (
        <div className={`ch-imgs n${Math.min(imgs.length, 4)}`}>
          {imgs.map((f) => (
            <button key={f.id} type="button" className="ch-img" onClick={() => setBig(f.id)} aria-label={`Open ${f.name}`}>
              <img src={fileUrl(f.id)} alt={f.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {rest.map((f) =>
        /^audio\//.test(f.type) ? (
          <div key={f.id} className="ch-audio"><audio controls preload="none" src={fileUrl(f.id)} aria-label={f.name} /><small className="ws-muted">{f.name}</small></div>
        ) : /^video\/(mp4|webm)/.test(f.type) ? (
          <video key={f.id} className="ch-video" controls preload="metadata" src={fileUrl(f.id)} aria-label={f.name} />
        ) : (
          <a key={f.id} className="ch-filecard" href={fileUrl(f.id, !/^(application\/pdf|text\/plain)/.test(f.type))} target="_blank" rel="noreferrer">
            <FileText size={22} />
            <span><b>{f.name}</b><small className="ws-muted">{fmtSize(f.size)} · {(f.name.split(".").pop() ?? "file").toUpperCase()}</small></span>
            <Download size={15} className="dl" />
          </a>
        ),
      )}
      {big && (
        <div className="ws-modal-scrim ch-lightbox" onClick={() => setBig(null)} role="dialog" aria-label="Image">
          <img src={fileUrl(big)} alt="" onClick={(e) => e.stopPropagation()} />
          <a className="ws-btn" href={fileUrl(big, true)} onClick={(e) => e.stopPropagation()}><Download size={14} /> Download</a>
        </div>
      )}
    </div>
  );
}

export function PreviewCard({ p }: { p: NonNullable<Msg["preview"]> }) {
  return (
    <a className="ch-preview" href={p.url} target="_blank" rel="noreferrer noopener">
      <span className="txt">
        <small className="ws-muted">{p.site}</small>
        <b>{p.title}</b>
        {p.description && <span className="desc">{p.description}</span>}
      </span>
      {p.image && <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </a>
  );
}

type Props = {
  msgs: Msg[]; meId: string; people: Person[]; groups: Group[]; channels: string[]; name: (id: string) => string; presence: PresenceMap;
  highlight: string | null; canTask: boolean; admin: boolean; readOnly?: boolean; inThread?: boolean; saved: Record<string, boolean>;
  unreadAfter?: string | null; more?: boolean; loading?: boolean; onLoadOlder?: () => Promise<void>; editLast?: number;
} & ListActions;

export default function MessageList(p: Props) {
  const { msgs, meId, people, groups, channels, name, presence, highlight, inThread, readOnly } = p;
  const box = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  /** Menus open upward for messages in the lower half of the screen. */
  const [up, setUp] = useState(false);
  const flip = (e: React.MouseEvent) => setUp((e.currentTarget as HTMLElement).getBoundingClientRect().top > window.innerHeight / 2);
  const [below, setBelow] = useState(false);
  const [loading, setLoading] = useState(false);
  const prevLen = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevHeight = useRef(0);
  const nearBottom = () => {
    const el = box.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Keep position when older messages load above; follow new ones only if already at the bottom.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = msgs[0]?.id ?? null;
    if (prevFirst.current && first !== prevFirst.current && msgs.some((m) => m.id === prevFirst.current) && prevLen.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (msgs.length > prevLen.current) {
      const mine = msgs[msgs.length - 1]?.userId === meId;
      if (!prevLen.current || mine || el.scrollHeight - el.scrollTop - el.clientHeight - (el.scrollHeight - prevHeight.current) < 160) el.scrollTop = el.scrollHeight;
      else setBelow(true);
    }
    prevFirst.current = first;
    prevLen.current = msgs.length;
    prevHeight.current = el.scrollHeight;
  }, [msgs, meId]);
  useEffect(() => {
    const h = highlight && document.getElementById(`m-${inThread ? "t" : "c"}-${highlight}`);
    if (h) h.scrollIntoView({ block: "center" });
  }, [highlight, msgs.length, inThread]);
  // Up arrow in an empty composer edits my last message.
  useEffect(() => {
    if (!p.editLast) return;
    const last = [...msgs].reverse().find((m) => m.userId === meId && !m.deleted && !m.system && !m.hookId);
    if (last) {
      setEditing(last.id);
      setDraft(last.body);
    }
  }, [p.editLast]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = async () => {
    const el = box.current;
    if (!el) return;
    if (nearBottom()) setBelow(false);
    if (el.scrollTop < 200 && p.more && p.onLoadOlder && !loading) {
      setLoading(true);
      await p.onLoadOlder().catch(() => {});
      setLoading(false);
    }
  };

  const save = async (m: Msg) => {
    await p.onEdit(m, draft);
    setEditing(null);
  };
  let lastDay = "";
  let shownNew = false;
  return (
    <div className="ch-list" ref={box} onScroll={onScroll}>
      {!inThread && p.more && <div className="ch-older">{loading ? "Loading older messages…" : <button type="button" className="ws-btn" onClick={() => { setLoading(true); p.onLoadOlder?.().finally(() => setLoading(false)); }}>Load older messages</button>}</div>}
      {msgs.length === 0 && <div className="ws-empty">{p.loading ? "Loading…" : "No messages yet. Say hello."}</div>}
      {msgs.map((m, i) => {
        const day = new Date(m.createdAt).toDateString();
        const showDay = !inThread && day !== lastDay;
        lastDay = day;
        const isNew = !inThread && !shownNew && !!p.unreadAfter && new Date(m.createdAt) > new Date(p.unreadAfter) && m.userId !== meId && !m.system;
        if (isNew) shownNew = true;
        const prev = msgs[i - 1];
        const compact = prev && !showDay && !isNew && !prev.system && !m.system && prev.userId === m.userId && prev.hookId === m.hookId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && !(inThread && i === 1);
        const domId = `m-${inThread ? "t" : "c"}-${m.id}`;
        const author = m.hookName ?? name(m.userId);
        if (m.system)
          return (
            <Fragment key={m.id}>
              {showDay && <div className="ch-day"><span>{fmtDay(m.createdAt)}</span></div>}
              <div id={domId} className="ch-sys"><Avatar id={m.userId} name={name(m.userId)} size={20} /> <b>{name(m.userId)}</b> {m.body} <small className="ws-muted">{fmtTime(m.createdAt)}</small></div>
            </Fragment>
          );
        const mine = m.userId === meId && !m.hookId;
        return (
          <Fragment key={m.id}>
            {showDay && <div className="ch-day"><span>{fmtDay(m.createdAt)}</span></div>}
            {isNew && <div className="ch-newline" role="separator"><span>New</span></div>}
            <div id={domId} className={`ch-msg${compact ? " compact" : ""}${highlight === m.id ? " hl" : ""}${m.mentions.includes(meId) ? " mentioned" : ""}${inThread && i === 0 ? " root" : ""}${menu === m.id || picker === m.id ? " active" : ""}`}>
              {compact ? <span className="ch-time-c">{fmtTime(m.createdAt)}</span> : <Avatar id={m.hookId ?? m.userId} name={author} presence={m.app || m.hookId ? undefined : presence[m.userId]?.presence} />}
              <div className="ch-content">
                {!compact && (
                  <div className="ch-head">
                    <b>{author}</b>
                    {(m.hookId || m.app) && <span className="ch-app">APP</span>}
                    {isGuestId(m.userId) && <span className="ch-guest">Guest</span>}
                    {!m.hookId && presence[m.userId]?.emoji && <span title={presence[m.userId].status}>{presence[m.userId].emoji}</span>}
                    <small title={new Date(m.createdAt).toLocaleString()}>{fmtTime(m.createdAt)}</small>
                    {m.pinned && <span className="ch-pinned"><Pin size={11} /> Pinned</span>}
                    {p.saved[m.id] && <span className="ch-pinned saved"><Bookmark size={11} /> Saved</span>}
                  </div>
                )}
                {!inThread && m.parentId && m.alsoChannel && <small className="ws-muted ch-also-note">replied to a thread · <button type="button" className="ch-linkbtn" onClick={() => p.onThread({ ...m, id: m.parentId! })}>View thread</button></small>}
                {m.deleted ? (
                  <i className="ws-muted">This message was deleted.</i>
                ) : editing === m.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); save(m); }} className="ch-editbox">
                    <textarea className="ws-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit message" rows={Math.min(10, draft.split("\n").length + 1)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(null);
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(m); }
                      }} />
                    <div className="ws-row"><small className="ws-muted">Enter to save · Shift+Enter for a new line · Esc to cancel</small><span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setEditing(null)}>Cancel</button><button className="ws-btn primary">Save</button></div>
                  </form>
                ) : (
                  <>
                    {m.body && <Rich text={m.body} people={people} groups={groups} meId={meId} channels={channels} onChannel={p.onChannel} />}
                    {m.editedAt && <small className="ws-muted"> (edited)</small>}
                  </>
                )}
                {!m.deleted && <Files m={m} />}
                {!m.deleted && m.shared && (
                  <button type="button" className="ch-shared" onClick={() => p.onOpenShared(m.shared!)}>
                    <span className="ch-head"><Avatar id={m.shared.userId} name={name(m.shared.userId)} size={18} /><b>{m.shared.hookName ?? name(m.shared.userId)}</b><small>{m.shared.channelKind === "dm" ? "Direct message" : `#${m.shared.channelName}`} · {new Date(m.shared.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small></span>
                    {m.shared.body && <Rich text={m.shared.body} people={people} groups={groups} meId={meId} big={false} />}
                    <Files m={m.shared} />
                  </button>
                )}
                {!m.deleted && m.preview && <PreviewCard p={m.preview} />}
                {m.taskId && <a className="ch-tasklink" href={`/workspace/tasks?task=${m.taskId}`}><ListTodo size={12} /> Task created</a>}
                {m.reactions.length > 0 && (
                  <div className="ch-reacts">
                    {m.reactions.map((r) => (
                      <button key={r.emoji} type="button" className={`ch-react${r.users.includes(meId) ? " mine" : ""}`} onClick={() => !readOnly && p.onReact(m, r.emoji)} title={`${r.users.map(name).join(", ")} reacted with ${r.emoji}`}>
                        {r.emoji} {r.users.length}
                      </button>
                    ))}
                    {!readOnly && <button type="button" className="ch-react add" onClick={(e) => { flip(e); setPicker(m.id); }} aria-label="Add reaction"><Smile size={13} /></button>}
                  </div>
                )}
                {!inThread && m.replyCount > 0 && !m.parentId && (
                  <button type="button" className="ch-replies" onClick={() => p.onThread(m)}>
                    <MessageSquare size={13} /> {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
                    {m.lastReplyAt && <small className="ws-muted"> · Last reply {fmtDay(m.lastReplyAt) === "Today" ? fmtTime(m.lastReplyAt) : fmtDay(m.lastReplyAt)}</small>}
                  </button>
                )}
              </div>
              {!m.deleted && !readOnly && (
                <div className="ch-actions" role="toolbar" aria-label="Message actions">
                  {QUICK.slice(0, 3).map((e) => <button key={e} type="button" className="ix-iconbtn ch-q" onClick={() => p.onReact(m, e)} aria-label={`React ${e}`}>{e}</button>)}
                  <button type="button" className="ix-iconbtn" onClick={(e) => { flip(e); setPicker(picker === m.id ? null : m.id); }} aria-label="Add reaction" title="Add reaction"><Smile size={15} /></button>
                  {!inThread && !m.parentId && <button type="button" className="ix-iconbtn" onClick={() => p.onThread(m)} aria-label="Reply in thread" title="Reply in thread"><MessageSquare size={15} /></button>}
                  <button type="button" className="ix-iconbtn" onClick={() => p.onShare(m)} aria-label="Share message" title="Share message"><Forward size={15} /></button>
                  <button type="button" className="ix-iconbtn" onClick={() => p.onSave(m, p.saved[m.id] ? undefined : null)} aria-label={p.saved[m.id] ? "Remove from saved" : "Save for later"} title={p.saved[m.id] ? "Remove from saved" : "Save for later"}>
                    {p.saved[m.id] ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
                  </button>
                  <button type="button" className="ix-iconbtn" onClick={(e) => { flip(e); setMenu(menu === m.id ? null : m.id); }} aria-label="More actions" aria-haspopup="menu" aria-expanded={menu === m.id}><MoreHorizontal size={15} /></button>
                  {picker === m.id && <EmojiPicker align={up ? "up" : "right"} onClose={() => setPicker(null)} onPick={(e) => { p.onReact(m, e); setPicker(null); }} />}
                  {menu === m.id && (
                    <Menu onClose={() => setMenu(null)} className={up ? "up" : ""}>
                      <button type="button" role="menuitem" onClick={() => p.onCopyLink(m)}><Copy size={14} /> Copy link</button>
                      {!inThread && !m.parentId && <button type="button" role="menuitem" onClick={() => p.onUnread(m)}><EyeOff size={14} /> Mark unread</button>}
                      <div className="ch-menu-sub"><span><Bell size={14} /> Remind me</span>
                        {laterOptions().map((o) => <button key={o.label} type="button" role="menuitem" onClick={() => p.onSave(m, o.at)}>{o.label}</button>)}
                      </div>
                      <button type="button" role="menuitem" onClick={() => p.onPin(m)}><Pin size={14} /> {m.pinned ? "Unpin from channel" : "Pin to channel"}</button>
                      {p.canTask && <button type="button" role="menuitem" onClick={() => p.onTask(m)}><ListTodo size={14} /> Make this a task</button>}
                      {mine && m.body !== undefined && <button type="button" role="menuitem" onClick={() => { setEditing(m.id); setDraft(m.body); }}><Pencil size={14} /> Edit message</button>}
                      {(mine || p.admin) && <button type="button" role="menuitem" className="danger" onClick={() => p.onDelete(m)}><Trash2 size={14} /> Delete message</button>}
                    </Menu>
                  )}
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
      {below && (
        <button type="button" className="ch-jump" onClick={() => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" }); setBelow(false); }}>
          <ArrowDown size={14} /> New messages
        </button>
      )}
    </div>
  );
}

export function Menu({ children, onClose, className = "" }: { children: React.ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return <div ref={ref} className={`ch-menu ${className}`} role="menu" onClick={(e) => { if ((e.target as HTMLElement).closest("[role=menuitem]")) onClose(); }}>{children}</div>;
}
