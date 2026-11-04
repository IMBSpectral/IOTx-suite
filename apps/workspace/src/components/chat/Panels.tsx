"use client";
import { useEffect, useMemo, useState } from "react";
import { Archive, Bell, BellOff, Check, Copy, Download, Hash, Lock, Plus, Search, Star, Trash2, Users, X } from "lucide-react";
import type { Boot } from "@/lib/page";
import { api } from "@/lib/client";
import { Avatar, Files } from "./MessageList";
import Rich from "./Rich";
import EmojiPicker from "./EmojiPicker";
import { fileUrl, fmtSize, localInput, type Channel, type ChatFile, type Group, type Msg, type Person, type Prefs, type PresenceMap } from "./types";

type Flash = (m: string) => void;

export function Modal({ title, onClose, children, footer, width = 480, label }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number; label?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-modal ch-modal" style={{ width }} role="dialog" aria-label={label ?? (typeof title === "string" ? title : "Dialog")}>
        <header><h3>{title}</h3><button type="button" className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Confirm({ text, ok = "Delete", onOk, onClose }: { text: string; ok?: string; onOk: () => void; onClose: () => void }) {
  return (
    <Modal title="Are you sure?" onClose={onClose} width={400} footer={<><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button type="button" className="ws-btn danger" autoFocus onClick={() => { onOk(); onClose(); }}>{ok}</button></>}>
      <p style={{ margin: 0 }}>{text}</p>
    </Modal>
  );
}

function PeoplePick({ people, picked, setPicked, exclude = [], presence }: { people: Person[]; picked: string[]; setPicked: (x: string[]) => void; exclude?: string[]; presence?: PresenceMap }) {
  const [q, setQ] = useState("");
  const list = people.filter((p) => !exclude.includes(p.id) && (`${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="ch-pick">
      <div className="ch-search"><Search size={14} /><input placeholder="Find people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find people" autoFocus /></div>
      {picked.length > 0 && <div className="ch-chips">{picked.map((id) => <span key={id} className="ix-chip">{people.find((p) => p.id === id)?.name}<button type="button" onClick={() => setPicked(picked.filter((x) => x !== id))} aria-label="Remove"><X size={11} /></button></span>)}</div>}
      <div className="ch-picklist">
        {list.length === 0 && <span className="ws-muted">Nobody matches.</span>}
        {list.map((p) => (
          <label key={p.id} className="ch-person">
            <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
            <Avatar id={p.id} name={p.name} size={24} presence={presence?.[p.id]?.presence} />
            <span>{p.name} <small className="ws-muted">{p.email}</small></span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function NewChannel({ boot, onClose, onMade, flash }: { boot: Boot; onClose: () => void; onMade: (id: string) => void; flash: Flash }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [priv, setPriv] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const make = async () => {
    try {
      const r = await api<{ channel: { id: string } }>("/chat/channels", { body: { name, topic, description, kind: priv ? "private" : "public", memberIds: members } });
      onMade(r.channel.id);
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const slug = name.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (
    <Modal title="Create a channel" onClose={onClose} label="New channel" footer={<><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button type="button" className="ws-btn primary" disabled={!slug} onClick={make}>Create</button></>}>
      <div className="ws-field"><label className="ws-label" htmlFor="nc-name">Name</label><input id="nc-name" className="ws-input" autoFocus placeholder="e.g. plan-budget" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && slug && make()} />
        {name && slug !== name && <small className="ws-muted">Will be #{slug}</small>}</div>
      <div className="ws-field"><label className="ws-label" htmlFor="nc-topic">Topic <span className="ws-muted">(optional)</span></label><input id="nc-topic" className="ws-input" value={topic} onChange={(e) => setTopic(e.target.value)} /></div>
      <div className="ws-field"><label className="ws-label" htmlFor="nc-desc">Description <span className="ws-muted">(optional)</span></label><textarea id="nc-desc" className="ws-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      {boot.me.perms["teamchat.private"] && (
        <label className="ws-row ws-field" style={{ gap: 6 }}><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Make private: only people you add can see it</label>
      )}
      <div className="ws-label">Add people <span className="ws-muted">(optional)</span></div>
      <PeoplePick people={boot.people} picked={members} setPicked={setMembers} exclude={[boot.me.id]} />
    </Modal>
  );
}

export function NewMessage({ boot, presence, onClose, onOpen }: { boot: Boot; presence: PresenceMap; onClose: () => void; onOpen: (ids: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <Modal title="New message" onClose={onClose} width={440} footer={<><span className="ws-muted" style={{ marginRight: "auto", fontSize: 12 }}>{picked.length > 1 ? "Group message" : "Pick one person, or several for a group"}</span><button type="button" className="ws-btn" onClick={() => onOpen([boot.me.id])}>Note to self</button><button type="button" className="ws-btn primary" disabled={!picked.length} onClick={() => onOpen(picked)}>Open</button></>}>
      <PeoplePick people={boot.people} picked={picked} setPicked={(x) => setPicked(x.slice(0, 8))} exclude={[boot.me.id]} presence={presence} />
    </Modal>
  );
}

type Browse = { id: string; kind: string; name: string; topic: string; description: string; members: number; joined: boolean; archived: boolean };
export function BrowseChannels({ onClose, onOpen, flash, canCreate, onCreate }: { onClose: () => void; onOpen: (id: string) => void; flash: Flash; canCreate: boolean; onCreate: () => void }) {
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<Browse[] | null>(null);
  const load = useMemo(() => () => api<{ channels: Browse[] }>(`/chat/channels?browse=1&q=${encodeURIComponent(q)}${archived ? "&archived=1" : ""}`).then((d) => setRows(d.channels)).catch((e) => flash(e.message)), [q, archived, flash]);
  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);
  const act = async (id: string, action: "join" | "leave") => {
    await api(`/chat/channels/${id}`, { body: { action } }).catch((e) => flash(e.message));
    load();
  };
  return (
    <Modal title="Browse channels" onClose={onClose} width={600}>
      <div className="ws-row" style={{ flexWrap: "nowrap" }}>
        <div className="ch-search" style={{ flex: 1 }}><Search size={14} /><input autoFocus placeholder="Search by name or topic" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search channels" /></div>
        <label className="ws-row" style={{ gap: 4, fontSize: 12.5, whiteSpace: "nowrap" }}><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived</label>
        {canCreate && <button type="button" className="ws-btn" onClick={onCreate}><Plus size={14} /> Create</button>}
      </div>
      <div className="ch-browse">
        {rows === null ? <span className="ws-muted">Loading…</span> : rows.length === 0 ? <span className="ws-muted">No channels match.</span> : rows.map((c) => (
          <div key={c.id} className="ch-brow">
            <button type="button" className="ch-brow-main" onClick={() => onOpen(c.id)}>
              <b>{c.kind === "private" ? <Lock size={13} /> : <Hash size={13} />} {c.name}</b>
              <small className="ws-muted">{c.joined && <span className="ch-joined"><Check size={11} /> Joined · </span>}{c.members} {c.members === 1 ? "member" : "members"}{c.archived ? " · Archived" : ""}{c.topic ? ` · ${c.topic}` : ""}</small>
            </button>
            {!c.archived && (c.joined ? (c.name !== "general" && <button type="button" className="ws-btn" onClick={() => act(c.id, "leave")}>Leave</button>) : c.kind === "public" && <button type="button" className="ws-btn primary" onClick={() => act(c.id, "join")}>Join</button>)}
          </div>
        ))}
      </div>
    </Modal>
  );
}

type Hook = { id: string; name: string; tail: string; createdBy: string; createdAt: string };
export function ChannelDetails({ channel, boot, presence, tab: tab0, onClose, flash, onLeft, onChanged, people, name }: {
  channel: Channel; boot: Boot; presence: PresenceMap; tab?: string; onClose: () => void; flash: Flash; onLeft: () => void; onChanged: () => void; people: Person[]; name: (id: string) => string;
}) {
  const [tab, setTab] = useState(tab0 ?? "about");
  const [info, setInfo] = useState<{ channel: Channel & { archivedAt: string | null; createdAt: string }; canManage: boolean; admin: boolean } | null>(null);
  const [edit, setEdit] = useState<{ name: string; topic: string; description: string } | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [newHook, setNewHook] = useState<{ name: string; url?: string } | null>(null);
  const [files, setFiles] = useState<(ChatFile & { createdAt: string; userId: string; messageId: string })[] | null>(null);
  const [retention, setRetention] = useState("");
  const [ask, setAsk] = useState<{ text: string; ok: string; run: () => void } | null>(null);
  const dm = channel.kind === "dm";
  const load = useMemo(() => () => api<{ channel: Channel & { archivedAt: string | null; createdAt: string }; canManage: boolean; admin: boolean }>(`/chat/channels/${channel.id}`).then((d) => {
    setInfo(d);
    setRetention(d.channel.retentionDays ? String(d.channel.retentionDays) : "");
  }).catch((e) => flash(e.message)), [channel.id, flash]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab === "integrations") api<{ hooks: Hook[] }>(`/chat/channels/${channel.id}/hooks`).then((d) => setHooks(d.hooks)).catch(() => {});
    if (tab === "files") api<{ files: typeof files }>(`/chat/channels/${channel.id}/files`).then((d) => setFiles(d.files)).catch(() => setFiles([]));
  }, [tab, channel.id]);
  const post = async (b: Record<string, unknown>, ok?: string) => {
    try {
      await api(`/chat/channels/${channel.id}`, { body: b });
      if (ok) flash(ok);
      load();
      onChanged();
      return true;
    } catch (e) {
      flash((e as Error).message);
      return false;
    }
  };
  const c = info?.channel;
  const members = c?.memberIds ?? channel.memberIds;
  const canRemove = !!info && (info.admin || (channel.kind === "private" && c?.createdBy === boot.me.id));
  const title = dm ? channel.dmWithAll.map(name).join(", ") || name(boot.me.id) : `${channel.kind === "private" ? "🔒" : "#"} ${channel.name}`;
  const tabs = dm ? [["about", "About"], ["members", "Members"], ["files", "Files"], ["settings", "Notifications"]] : [["about", "About"], ["members", `Members ${members.length}`], ["files", "Files"], ["settings", "Settings"], ["integrations", "Integrations"]];
  return (
    <Modal title={title} onClose={onClose} width={620} label="Channel details">
      <div className="ws-tabs ch-tabs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "about" && (
        <div className="ch-about">
          {c?.archivedAt && <div className="ch-banner"><Archive size={14} /> Archived {new Date(c.archivedAt).toLocaleDateString()}. It's read-only.</div>}
          {edit ? (
            <>
              {!dm && info?.canManage && !(c?.name === "general") && <div className="ws-field"><label className="ws-label" htmlFor="cd-name">Name</label><input id="cd-name" className="ws-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>}
              <div className="ws-field"><label className="ws-label" htmlFor="cd-topic">Topic</label><input id="cd-topic" className="ws-input" value={edit.topic} onChange={(e) => setEdit({ ...edit, topic: e.target.value })} /></div>
              <div className="ws-field"><label className="ws-label" htmlFor="cd-desc">Description</label><textarea id="cd-desc" className="ws-input" rows={3} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
              <div className="ws-row"><span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setEdit(null)}>Cancel</button>
                <button type="button" className="ws-btn primary" onClick={async () => {
                  const b: Record<string, unknown> = { action: "update", topic: edit.topic, description: edit.description };
                  if (edit.name !== c?.name && info?.canManage) b.name = edit.name;
                  if (await post(b, "Saved")) setEdit(null);
                }}>Save</button></div>
            </>
          ) : (
            <>
              {!dm && <div className="ch-kv"><span className="ws-label">Channel name</span><span>#{c?.name ?? channel.name}</span></div>}
              <div className="ch-kv"><span className="ws-label">Topic</span><span>{c?.topic || <i className="ws-muted">No topic</i>}</span></div>
              {!dm && <div className="ch-kv"><span className="ws-label">Description</span><span style={{ whiteSpace: "pre-wrap" }}>{c?.description || <i className="ws-muted">No description</i>}</span></div>}
              {c && <div className="ch-kv"><span className="ws-label">Created</span><span>by {name(c.createdBy)} on {new Date(c.createdAt).toLocaleDateString([], { dateStyle: "long" })}</span></div>}
              {!dm && !c?.archivedAt && channel.joined && <button type="button" className="ws-btn" onClick={() => setEdit({ name: c?.name ?? channel.name, topic: c?.topic ?? "", description: c?.description ?? "" })}>Edit</button>}
            </>
          )}
        </div>
      )}
      {tab === "members" && (
        <div>
          {!dm && !c?.archivedAt && (adding ? (
            <div className="ch-addbox">
              <PeoplePick people={people} picked={adding} setPicked={setAdding} exclude={members} presence={presence} />
              <div className="ws-row"><span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setAdding(null)}>Cancel</button><button type="button" className="ws-btn primary" disabled={!adding.length} onClick={async () => { if (await post({ action: "add", memberIds: adding }, "Added")) setAdding(null); }}>Add</button></div>
            </div>
          ) : (channel.joined || info?.admin) && channel.name !== "general" && <button type="button" className="ws-btn" onClick={() => setAdding([])}><Plus size={14} /> Add people</button>)}
          <div className="ch-members">
            {members.map((id) => (
              <div key={id} className="ch-person">
                <Avatar id={id} name={name(id)} size={28} presence={presence[id]?.presence} />
                <span style={{ flex: 1 }}>{name(id)}{id === boot.me.id ? " (you)" : ""}{c?.createdBy === id && !dm ? <small className="ws-muted"> · creator</small> : null}
                  {presence[id]?.status && <small className="ws-muted"> · {presence[id].emoji} {presence[id].status}</small>}</span>
                {!dm && canRemove && id !== boot.me.id && c?.name !== "general" && <button type="button" className="ws-btn" onClick={() => setAsk({ text: `Remove ${name(id)} from #${channel.name}?`, ok: "Remove", run: () => post({ action: "remove", userId: id }, "Removed") })}>Remove</button>}
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === "files" && (
        <div className="ch-filelist">
          {files === null ? <span className="ws-muted">Loading…</span> : files.length === 0 ? <span className="ws-muted">No files shared here yet.</span> : files.map((f) => (
            <a key={f.id} className="ch-filecard" href={fileUrl(f.id, !/^(image|application\/pdf|text\/plain|audio|video)/.test(f.type))} target="_blank" rel="noreferrer">
              {/^image\//.test(f.type) ? <img src={fileUrl(f.id)} alt="" /> : <Download size={18} />}
              <span><b>{f.name}</b><small className="ws-muted">{name(f.userId)} · {new Date(f.createdAt).toLocaleDateString()} · {fmtSize(f.size)}</small></span>
            </a>
          ))}
        </div>
      )}
      {tab === "settings" && (
        <div className="ch-settings">
          {channel.joined && (
            <>
              <div className="ws-label">Notify me about</div>
              {([["all", "Every new message"], ["mentions", "Mentions and direct messages"], ["none", "Nothing"]] as const).map(([k, l]) => (
                <label key={k} className="ch-radio"><input type="radio" name="nl" checked={(channel.notifyLevel ?? "all") === k} onChange={() => post({ action: "prefs", notifyLevel: k })} /> {l}</label>
              ))}
              <label className="ch-radio"><input type="checkbox" checked={channel.muted} onChange={(e) => post({ action: "prefs", muted: e.target.checked }, e.target.checked ? "Muted: it won't show as unread unless you're mentioned" : "Unmuted")} /> {channel.muted ? <BellOff size={14} /> : <Bell size={14} />} Mute {dm ? "conversation" : "channel"}</label>
              <label className="ch-radio"><input type="checkbox" checked={channel.starred} onChange={(e) => post({ action: "prefs", starred: e.target.checked })} /> <Star size={14} /> Star (keeps it at the top)</label>
            </>
          )}
          {!dm && (
            <>
              <hr />
              {channel.joined && channel.name !== "general" && <button type="button" className="ws-btn" onClick={() => setAsk({ text: `Leave #${channel.name}?`, ok: "Leave", run: async () => { if (await post({ action: "leave" }, `You left #${channel.name}`)) { onLeft(); onClose(); } } })}>Leave channel</button>}
              {info?.canManage && channel.name !== "general" && (c?.archivedAt
                ? <button type="button" className="ws-btn" onClick={() => post({ action: "update", archived: false }, "Unarchived")}><Archive size={14} /> Unarchive channel</button>
                : <button type="button" className="ws-btn danger" onClick={() => setAsk({ text: `Archive #${channel.name}? Nobody can post in it, but its history stays searchable. You can unarchive it later.`, ok: "Archive", run: async () => { if (await post({ action: "update", archived: true }, "Archived")) { onLeft(); onClose(); } } })}><Archive size={14} /> Archive channel</button>)}
              {info?.admin && (
                <div className="ch-admin">
                  <div className="ws-label">Admin</div>
                  <div className="ws-row" style={{ flexWrap: "nowrap" }}>
                    <span>Keep messages for</span>
                    <input className="ws-input" style={{ width: 90 }} type="number" min={1} max={3650} placeholder="forever" value={retention} onChange={(e) => setRetention(e.target.value)} aria-label="Retention in days" />
                    <span>days</span>
                    <button type="button" className="ws-btn" onClick={() => post({ action: "update", retentionDays: retention ? Number(retention) : null }, retention ? `Messages older than ${retention} days will be deleted` : "Messages are kept forever")}>Save</button>
                  </div>
                  <a className="ws-btn" href={`/workspace/api/chat/channels/${channel.id}/export`} download><Download size={14} /> Export messages (JSON)</a>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {tab === "integrations" && (
        <div className="ch-settings">
          <p className="ws-muted" style={{ margin: 0 }}>Incoming webhooks let other tools post here. Send <code className="ch-code">{"{\"text\": \"Deploy finished\"}"}</code> as JSON to the webhook's address.</p>
          {hooks.map((h) => (
            <div key={h.id} className="ch-person">
              <Avatar id={h.id} name={h.name} size={26} />
              <span style={{ flex: 1 }}>{h.name} <small className="ws-muted">…{h.tail} · added by {name(h.createdBy)}</small></span>
              <button type="button" className="ix-iconbtn" aria-label={`Remove ${h.name}`} onClick={() => setAsk({ text: `Remove the "${h.name}" webhook? Anything using it will stop posting.`, ok: "Remove", run: async () => { await api(`/chat/integrations/${h.id}`, { method: "DELETE" }).catch((e) => flash(e.message)); setHooks(hooks.filter((x) => x.id !== h.id)); } })}><Trash2 size={15} /></button>
            </div>
          ))}
          {newHook?.url ? (
            <div className="ch-banner ok">
              <b>Copy this address now. It won't be shown again.</b>
              <div className="ws-row" style={{ flexWrap: "nowrap" }}><input className="ws-input" readOnly value={newHook.url} onFocus={(e) => e.target.select()} aria-label="Webhook address" /><button type="button" className="ws-btn" onClick={() => { navigator.clipboard?.writeText(newHook.url!); flash("Copied"); }}><Copy size={14} /> Copy</button></div>
              <button type="button" className="ws-btn" onClick={() => setNewHook(null)}>Done</button>
            </div>
          ) : newHook ? (
            <div className="ws-row" style={{ flexWrap: "nowrap" }}>
              <input className="ws-input" autoFocus placeholder="Name, e.g. Deploy bot" value={newHook.name} onChange={(e) => setNewHook({ name: e.target.value })} aria-label="Webhook name" />
              <button type="button" className="ws-btn primary" onClick={async () => {
                try {
                  const r = await api<{ hook: { id: string; name: string; token: string } }>(`/chat/channels/${channel.id}/hooks`, { body: { name: newHook.name } });
                  setNewHook({ name: r.hook.name, url: `${window.location.origin}/workspace/api/chat/hooks/${r.hook.token}` });
                  setHooks([...hooks, { id: r.hook.id, name: r.hook.name, tail: r.hook.token.slice(-4), createdBy: boot.me.id, createdAt: new Date().toISOString() }]);
                } catch (e) {
                  flash((e as Error).message);
                }
              }}>Create</button>
            </div>
          ) : channel.joined && !c?.archivedAt && <button type="button" className="ws-btn" onClick={() => setNewHook({ name: "" })}><Plus size={14} /> Add incoming webhook</button>}
        </div>
      )}
      {ask && <Confirm text={ask.text} ok={ask.ok} onOk={ask.run} onClose={() => setAsk(null)} />}
    </Modal>
  );
}

export function ShareDialog({ msg, channels, title, people, groups, meId, onClose, onShare }: {
  msg: Msg; channels: Channel[]; title: (c: Channel) => string; people: Person[]; groups: Group[]; meId: string; onClose: () => void; onShare: (channelId: string, comment: string) => Promise<boolean>;
}) {
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [comment, setComment] = useState("");
  const list = channels.filter((c) => c.joined && title(c).toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Share this message" onClose={onClose} width={520} footer={<><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button type="button" className="ws-btn primary" disabled={!to} onClick={async () => { if (await onShare(to, comment)) onClose(); }}>Share</button></>}>
      <div className="ch-search"><Search size={14} /><input autoFocus placeholder="Share to a channel or person" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a conversation" /></div>
      <div className="ch-picklist" style={{ maxHeight: 160 }}>
        {list.map((c) => (
          <label key={c.id} className="ch-person"><input type="radio" name="share-to" checked={to === c.id} onChange={() => setTo(c.id)} /> {c.kind === "dm" ? <Users size={14} /> : c.kind === "private" ? <Lock size={14} /> : <Hash size={14} />} {title(c)}</label>
        ))}
      </div>
      <textarea className="ws-input" rows={2} placeholder="Add a message, if you like" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
      <div className="ch-shared static">
        <span className="ch-head"><b>{people.find((p) => p.id === msg.userId)?.name ?? msg.hookName ?? "Someone"}</b><small>{new Date(msg.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small></span>
        {msg.body && <Rich text={msg.body} people={people} groups={groups} meId={meId} big={false} />}
        <Files m={msg} />
      </div>
    </Modal>
  );
}

export function Switcher({ channels, people, title, presence, meId, onClose, onChannel, onPerson }: {
  channels: Channel[]; people: Person[]; title: (c: Channel) => string; presence: PresenceMap; meId: string; onClose: () => void; onChannel: (id: string) => void; onPerson: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const t = q.toLowerCase().replace(/^[#@]/, "");
  const items = [
    ...channels.filter((c) => c.joined && title(c).toLowerCase().includes(t)).map((c) => ({ key: c.id, label: title(c), kind: c.kind, unread: c.unread, go: () => onChannel(c.id) })),
    ...people.filter((p) => p.id !== meId && `${p.name} ${p.email}`.toLowerCase().includes(t) && !channels.some((c) => c.kind === "dm" && c.dmWithAll.length === 1 && c.dmWith === p.id && title(c).toLowerCase().includes(t))).map((p) => ({ key: p.id, label: p.name, kind: "person", unread: 0, go: () => onPerson(p.id) })),
  ].slice(0, 12);
  const i = Math.min(sel, Math.max(0, items.length - 1));
  return (
    <Modal title="Jump to…" onClose={onClose} width={480} label="Quick switcher">
      <div className="ch-search"><Search size={14} /><input autoFocus placeholder="Channel or person" value={q} aria-label="Jump to"
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((i + 1) % Math.max(1, items.length)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setSel((i - 1 + items.length) % Math.max(1, items.length)); }
          if (e.key === "Enter" && items[i]) { e.preventDefault(); items[i].go(); }
        }} /></div>
      <div className="ch-picklist">
        {items.map((x, j) => (
          <button key={x.key} type="button" className={`ch-person btn${j === i ? " on" : ""}`} onClick={x.go} onMouseEnter={() => setSel(j)}>
            {x.kind === "person" ? <Avatar id={x.key} name={x.label} size={22} presence={presence[x.key]?.presence} /> : x.kind === "private" ? <Lock size={14} /> : x.kind === "dm" ? <Users size={14} /> : <Hash size={14} />}
            <span style={{ flex: 1 }}>{x.label}</span>
            {x.unread > 0 && <span className="ws-badge">{x.unread}</span>}
          </button>
        ))}
        {items.length === 0 && <span className="ws-muted">Nothing matches.</span>}
      </div>
      <small className="ws-muted">↑↓ to move · Enter to open · Esc to close</small>
    </Modal>
  );
}

export function PrefsDialog({ prefs, onClose, onSave, push }: { prefs: Prefs; onClose: () => void; onSave: (p: Partial<Prefs>) => Promise<void>; push?: React.ReactNode }) {
  const [status, setStatus] = useState(prefs.status ?? "");
  const [emoji, setEmoji] = useState(prefs.emoji ?? "");
  const [clear, setClear] = useState("");
  const [pick, setPick] = useState(false);
  const dndOn = !!prefs.dndUntil && new Date(prefs.dndUntil) > new Date();
  const presets = [["📅", "In a meeting", 60], ["🚌", "Commuting", 30], ["🤒", "Out sick", 0], ["🌴", "Vacationing", 0], ["🏡", "Working remotely", 0]] as const;
  const untilFor = (v: string) => (v === "" ? null : v === "today" ? (() => { const d = new Date(); d.setHours(23, 59, 0, 0); return d.toISOString(); })() : new Date(Date.now() + Number(v) * 60_000).toISOString());
  const enableDesktop = async (on: boolean) => {
    if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const r = await Notification.requestPermission();
      if (r !== "granted") return onSave({ desktop: false });
    }
    await onSave({ desktop: on });
  };
  return (
    <Modal title="Status and notifications" onClose={onClose} width={500} label="Preferences">
      <div className="ws-label">Status</div>
      <div className="ws-row" style={{ flexWrap: "nowrap", position: "relative" }}>
        <button type="button" className="ws-btn" onClick={() => setPick(!pick)} aria-label="Status emoji">{emoji || "🙂"}</button>
        {pick && <EmojiPicker align="left" onClose={() => setPick(false)} onPick={(e) => { setEmoji(e); setPick(false); }} />}
        <input className="ws-input" placeholder="What's your status?" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status text" />
      </div>
      <div className="ch-chips">
        {presets.map(([e, t, m]) => <button key={t} type="button" className="ix-chip" onClick={() => { setEmoji(e); setStatus(t); setClear(m ? String(m) : "today"); }}>{e} {t}</button>)}
      </div>
      <div className="ws-row" style={{ flexWrap: "nowrap" }}>
        <label className="ws-label" htmlFor="pf-clear" style={{ margin: 0 }}>Clear after</label>
        <select id="pf-clear" className="ws-select" value={clear} onChange={(e) => setClear(e.target.value)}>
          <option value="">Don't clear</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="today">Today</option>
        </select>
        <span style={{ flex: 1 }} />
        {(prefs.status || prefs.emoji) && <button type="button" className="ws-btn" onClick={() => onSave({ status: "", emoji: "", until: null })}>Clear</button>}
        <button type="button" className="ws-btn primary" onClick={() => onSave({ status, emoji, until: untilFor(clear) })}>Save status</button>
      </div>
      <hr />
      <div className="ws-label">Availability</div>
      <label className="ch-radio"><input type="checkbox" checked={!!prefs.away} onChange={(e) => onSave({ away: e.target.checked })} /> Set myself as away</label>
      <div className="ws-row">
        <span>Pause notifications:</span>
        {dndOn ? (
          <>
            <span className="ws-muted">until {new Date(prefs.dndUntil!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            <button type="button" className="ws-btn" onClick={() => onSave({ dndUntil: null })}>Resume</button>
          </>
        ) : (
          [["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"], ["today", "Until tomorrow"]].map(([v, l]) => (
            <button key={v} type="button" className="ws-btn" onClick={() => onSave({ dndUntil: v === "today" ? (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString(); })() : new Date(Date.now() + Number(v) * 60_000).toISOString() })}>{l}</button>
          ))
        )}
      </div>
      <hr />
      <div className="ws-label">Notifications</div>
      <label className="ch-radio"><input type="checkbox" checked={!!prefs.desktop} onChange={(e) => enableDesktop(e.target.checked)} /> Desktop notifications when Chat is in the background</label>
      {push}
      <label className="ch-radio"><input type="checkbox" checked={prefs.email !== false} onChange={(e) => onSave({ email: e.target.checked })} /> Email me about mentions and direct messages I miss (after 5 minutes away)</label>
      <small className="ws-muted">Each channel's own setting (all messages, mentions or nothing) is in its details, under Settings.</small>
    </Modal>
  );
}

export function GroupsDialog({ boot, groups, onClose, onChanged, flash }: { boot: Boot; groups: Group[]; onClose: () => void; onChanged: () => void; flash: Flash }) {
  const [edit, setEdit] = useState<{ id?: string; handle: string; name: string; memberIds: string[] } | null>(null);
  const save = async () => {
    if (!edit) return;
    try {
      if (edit.id) await api(`/chat/groups/${edit.id}`, { method: "PATCH", body: edit });
      else await api("/chat/groups", { body: edit });
      setEdit(null);
      onChanged();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  return (
    <Modal title="User groups" onClose={onClose} width={540}>
      {edit ? (
        <>
          <div className="ws-row" style={{ flexWrap: "nowrap" }}>
            <div style={{ flex: 1 }}><label className="ws-label" htmlFor="ug-h">Handle</label><input id="ug-h" className="ws-input" autoFocus placeholder="design" value={edit.handle} onChange={(e) => setEdit({ ...edit, handle: e.target.value })} /></div>
            <div style={{ flex: 1 }}><label className="ws-label" htmlFor="ug-n">Name</label><input id="ug-n" className="ws-input" placeholder="Design team" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          </div>
          <PeoplePick people={boot.people} picked={edit.memberIds} setPicked={(x) => setEdit({ ...edit, memberIds: x })} />
          <div className="ws-row"><span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setEdit(null)}>Cancel</button><button type="button" className="ws-btn primary" disabled={!edit.handle.trim()} onClick={save}>Save</button></div>
        </>
      ) : (
        <>
          <p className="ws-muted" style={{ margin: 0 }}>Mention a group, like @design, to notify everyone in it.</p>
          {groups.map((g) => (
            <div key={g.id} className="ch-person">
              <Users size={16} />
              <span style={{ flex: 1 }}><b>@{g.handle}</b> {g.name} <small className="ws-muted">· {g.memberIds.length} {g.memberIds.length === 1 ? "person" : "people"}</small></span>
              {(g.createdBy === boot.me.id || boot.me.perms["teamchat.admin"]) && (
                <>
                  <button type="button" className="ws-btn" onClick={() => setEdit({ id: g.id, handle: g.handle, name: g.name, memberIds: g.memberIds })}>Edit</button>
                  <button type="button" className="ix-iconbtn" aria-label={`Delete @${g.handle}`} onClick={async () => { await api(`/chat/groups/${g.id}`, { method: "DELETE" }).catch((e) => flash(e.message)); onChanged(); }}><Trash2 size={15} /></button>
                </>
              )}
            </div>
          ))}
          <button type="button" className="ws-btn" onClick={() => setEdit({ handle: "", name: "", memberIds: [] })}><Plus size={14} /> New group</button>
        </>
      )}
    </Modal>
  );
}

export function KeysDialog({ onClose }: { onClose: () => void }) {
  const keys = [
    ["Ctrl/⌘ + K", "Jump to a channel or person"], ["Alt + ↑ / ↓", "Previous / next conversation"], ["Alt + Shift + ↑ / ↓", "Previous / next unread"],
    ["Esc", "Mark the conversation read, or close"], ["↑ in an empty box", "Edit your last message"], ["Enter / Shift + Enter", "Send / new line"],
    ["Ctrl/⌘ + B, I, Shift + X", "Bold, italic, strikethrough"], ["Ctrl/⌘ + Alt + Shift + C", "Code block"], ["@, :, /", "Mention, emoji, command"], ["Ctrl/⌘ + /", "This list"],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={460}>
      <table className="ch-keys"><tbody>{keys.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
    </Modal>
  );
}

export function MakeTask({ msg, onClose, flash, boot }: { msg: Msg; onClose: () => void; flash: Flash; boot: Boot }) {
  const [projects, setProjects] = useState<{ id: string; name: string; memberIds: string[] }[]>([]);
  const [pid, setPid] = useState("");
  const [title, setTitle] = useState((msg.body.split("\n")[0] || msg.files[0]?.name || "").slice(0, 200));
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  useEffect(() => {
    api<{ projects: { id: string; name: string; memberIds: string[] }[] }>("/tasks/projects").then((d) => { setProjects(d.projects); setPid(d.projects[0]?.id ?? ""); }).catch((e) => flash(e.message));
  }, [flash]);
  const proj = projects.find((p) => p.id === pid);
  const make = async () => {
    try {
      await api(`/chat/messages/${msg.id}/task`, { body: { projectId: pid, title, assigneeId: assignee || undefined, due: due || undefined } });
      flash("Task created");
      onClose();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  return (
    <Modal title="Make this a task" onClose={onClose} footer={<><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button type="button" className="ws-btn primary" disabled={!pid || !title.trim()} onClick={make}>Create task</button></>}>
      {projects.length === 0 ? <p className="ws-muted">You aren't in any project yet. Create one in Tasks first.</p> : (
        <>
          <div className="ws-field"><label className="ws-label" htmlFor="mt-title">Title</label><input id="mt-title" className="ws-input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="ws-field"><label className="ws-label" htmlFor="mt-proj">Project</label>
            <select id="mt-proj" className="ws-select" value={pid} onChange={(e) => setPid(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div className="ws-row">
            <div style={{ flex: 1 }}><label className="ws-label" htmlFor="mt-as">Assignee</label>
              <select id="mt-as" className="ws-select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {boot.people.filter((p) => proj?.memberIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></div>
            <div style={{ flex: 1 }}><label className="ws-label" htmlFor="mt-due">Due</label><input id="mt-due" type="date" className="ws-input" value={due} onChange={(e) => setDue(e.target.value)} /></div>
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Views in the main pane ────────────────────────────────────────────────

type SavedItem = { remindAt: string | null; done: boolean; savedAt: string; message: Msg };
export function SavedView({ name, people, groups, meId, onOpen, flash, onChanged }: { name: (id: string) => string; people: Person[]; groups: Group[]; meId: string; onOpen: (m: Msg) => void; flash: Flash; onChanged: () => void }) {
  const [items, setItems] = useState<SavedItem[] | null>(null);
  const [tab, setTab] = useState<"open" | "done">("open");
  const load = useMemo(() => () => api<{ items: SavedItem[] }>("/chat/saved").then((d) => setItems(d.items)).catch((e) => flash(e.message)), [flash]);
  useEffect(() => { load(); }, [load]);
  const act = async (m: Msg, b: Record<string, unknown>) => {
    await api(`/chat/messages/${m.id}/save`, { body: b }).catch((e) => flash(e.message));
    load();
    onChanged();
  };
  const list = (items ?? []).filter((x) => (tab === "done" ? x.done : !x.done));
  return (
    <div className="ch-list ch-view">
      <div className="ws-tabs ch-tabs" role="tablist" style={{ padding: "0 16px" }}>
        <button type="button" role="tab" aria-selected={tab === "open"} className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>In progress</button>
        <button type="button" role="tab" aria-selected={tab === "done"} className={tab === "done" ? "on" : ""} onClick={() => setTab("done")}>Completed</button>
      </div>
      {items === null ? <div className="ws-empty">Loading…</div> : list.length === 0 && <div className="ws-empty">{tab === "open" ? "Save messages with the bookmark button to come back to them." : "Nothing completed yet."}</div>}
      {list.map((x) => (
        <div key={x.message.id} className="ch-result">
          <button type="button" className="ch-result-main" onClick={() => onOpen(x.message)}>
            <small className="ws-muted">{x.message.channelKind === "dm" ? "Direct message" : `#${x.message.channelName}`} · {name(x.message.userId)} · {new Date(x.message.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              {x.remindAt && <b className={new Date(x.remindAt) < new Date() ? "ch-due" : ""}> · Reminder {new Date(x.remindAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</b>}</small>
            {x.message.body ? <Rich text={x.message.body} people={people} groups={groups} meId={meId} big={false} /> : <Files m={x.message} />}
          </button>
          <div className="ws-row">
            <button type="button" className="ws-btn" onClick={() => act(x.message, { done: !x.done })}><Check size={14} /> {x.done ? "Move back" : "Mark complete"}</button>
            {x.remindAt && <button type="button" className="ws-btn" onClick={() => act(x.message, { remindAt: null })}>Remove reminder</button>}
            <button type="button" className="ws-btn" onClick={() => act(x.message, { saved: false })}>Remove</button>
          </div>
        </div>
      ))}
    </div>
  );
}

type Sched = { id: string; channelId: string; channelName: string; channelKind: string; body: string; fileIds: string[]; sendAt: string; parentId: string | null };
export function ScheduledView({ flash, onOpenChannel }: { flash: Flash; onOpenChannel: (id: string) => void }) {
  const [rows, setRows] = useState<Sched[] | null>(null);
  const [edit, setEdit] = useState<{ id: string; body: string; sendAt: string } | null>(null);
  const load = useMemo(() => () => api<{ scheduled: Sched[] }>("/chat/scheduled").then((d) => setRows(d.scheduled)).catch((e) => flash(e.message)), [flash]);
  useEffect(() => { load(); }, [load]);
  const patch = async (id: string, b: Record<string, unknown>, ok: string) => {
    try {
      await api(`/chat/scheduled/${id}`, { method: "PATCH", body: b });
      flash(ok);
      setEdit(null);
      load();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  return (
    <div className="ch-list ch-view">
      {rows === null ? <div className="ws-empty">Loading…</div> : rows.length === 0 && <div className="ws-empty">No scheduled messages. Use the clock next to Send to schedule one.</div>}
      {(rows ?? []).map((s) => (
        <div key={s.id} className="ch-result">
          <small className="ws-muted">To {s.channelKind === "dm" ? "a direct message" : `#${s.channelName}`}{s.parentId ? " (thread)" : ""} · sends {new Date(s.sendAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{s.fileIds.length ? ` · ${s.fileIds.length} file(s)` : ""}</small>
          {edit?.id === s.id ? (
            <>
              <textarea className="ws-input" rows={3} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} aria-label="Message" />
              <div className="ws-row"><input type="datetime-local" className="ws-input" style={{ width: "auto" }} value={edit.sendAt} onChange={(e) => setEdit({ ...edit, sendAt: e.target.value })} aria-label="Send at" />
                <span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setEdit(null)}>Cancel</button>
                <button type="button" className="ws-btn primary" onClick={() => patch(s.id, { body: edit.body, sendAt: new Date(edit.sendAt).toISOString() }, "Updated")}>Save</button></div>
            </>
          ) : (
            <>
              <div className="ch-body" style={{ whiteSpace: "pre-wrap" }}>{s.body}</div>
              <div className="ws-row">
                <button type="button" className="ws-btn" onClick={() => setEdit({ id: s.id, body: s.body, sendAt: localInput(new Date(s.sendAt)) })}>Edit</button>
                <button type="button" className="ws-btn" onClick={async () => { await patch(s.id, { sendNow: true }, "Sent"); onOpenChannel(s.channelId); }}>Send now</button>
                <button type="button" className="ws-btn" onClick={async () => { await api(`/chat/scheduled/${s.id}`, { method: "DELETE" }).catch((e) => flash(e.message)); load(); }}>Cancel message</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

type FileRow = ChatFile & { createdAt: string; userId: string; channelId: string; messageId: string };
export function FilesView({ name, flash, onOpen }: { name: (id: string) => string; flash: Flash; onOpen: (f: FileRow) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<FileRow[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api<{ files: FileRow[] }>(`/chat/files?q=${encodeURIComponent(q)}`).then((d) => setRows(d.files)).catch((e) => flash(e.message)), 150);
    return () => clearTimeout(t);
  }, [q, flash]);
  return (
    <div className="ch-list ch-view">
      <div style={{ padding: "4px 16px 8px" }}><div className="ch-search"><Search size={14} /><input placeholder="Search files by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files" /></div></div>
      {rows === null ? <div className="ws-empty">Loading…</div> : rows.length === 0 && <div className="ws-empty">No files found.</div>}
      <div className="ch-filegrid">
        {(rows ?? []).map((f) => (
          <div key={f.id} className="ch-fcell">
            <button type="button" className="thumb" onClick={() => onOpen(f)} aria-label={`Show ${f.name} in its conversation`}>
              {/^image\//.test(f.type) ? <img src={fileUrl(f.id)} alt="" loading="lazy" /> : <span className="ext">{(f.name.split(".").pop() ?? "").slice(0, 5).toUpperCase()}</span>}
            </button>
            <a href={fileUrl(f.id, true)} className="nm" title={f.name}>{f.name}</a>
            <small className="ws-muted">{name(f.userId)} · {new Date(f.createdAt).toLocaleDateString()} · {fmtSize(f.size)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}
