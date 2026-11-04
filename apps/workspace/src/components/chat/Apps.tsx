"use client";
import { useEffect, useState } from "react";
import { Bot, Copy, Plus, Trash2, X, Zap } from "lucide-react";
import type { Boot } from "@/lib/page";
import { api } from "@/lib/client";
import { Modal } from "./Panels";
import type { Channel } from "./types";

type Flash = (m: string) => void;
const copy = (s: string, flash: Flash) => navigator.clipboard.writeText(s).then(() => flash("Copied"), () => flash("Couldn't copy"));

// ── Push on this device ────────────────────────────────────────────────────

const PUSH_SCOPE = "/workspace/push/";
const bytes = (b64u: string) => {
  const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64u.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const pushable = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";

async function activeReg() {
  const reg = await navigator.serviceWorker.register("/workspace/push-sw.js", { scope: PUSH_SCOPE });
  if (!reg.active) {
    await new Promise<void>((res) => {
      const sw = reg.installing ?? reg.waiting;
      if (!sw) return res();
      sw.addEventListener("statechange", () => sw.state === "activated" && res());
    });
  }
  return reg;
}

/** "Push notifications on this device": works with Chat closed (and on phones, from the home-screen app). */
export function PushToggle({ flash }: { flash: Flash }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pushable()) return;
    navigator.serviceWorker
      .getRegistration(PUSH_SCOPE)
      .then((r) => r?.pushManager.getSubscription())
      .then((s) => setOn(!!s))
      .catch(() => setOn(false));
  }, []);
  if (!pushable()) return <small className="ws-muted">This browser can&apos;t get push notifications. On iPhone, add Chat to the home screen first.</small>;
  const enable = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site in the browser's settings.");
      const reg = await activeReg();
      const { publicKey } = await api<{ publicKey: string }>("/push");
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(publicKey) }));
      await api("/push", { body: { subscription: sub.toJSON() } });
      await api("/chat/prefs", { body: { push: true } });
      setOn(true);
      flash("Push notifications are on for this device");
    } catch (e) {
      flash((e as Error).message);
    }
    setBusy(false);
  };
  const disable = async () => {
    setBusy(true);
    try {
      const sub = await (await navigator.serviceWorker.getRegistration(PUSH_SCOPE))?.pushManager.getSubscription();
      if (sub) {
        await api("/push", { method: "DELETE", body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setOn(false);
    } catch (e) {
      flash((e as Error).message);
    }
    setBusy(false);
  };
  const test = () => api<{ delivered: number }>("/push/test", { body: {} }).then((r) => flash(r.delivered ? "Sent. It shows when this tab is in the background or closed." : "No device took it. Turn push off and on again."), (e) => flash(e.message));
  return (
    <div className="ws-row">
      <label className="ch-radio" style={{ margin: 0 }}>
        <input type="checkbox" checked={!!on} disabled={busy || on === null} onChange={(e) => (e.target.checked ? enable() : disable())} /> Push notifications on this device, even with Chat closed
      </label>
      {on && <button type="button" className="ws-btn" onClick={test}>Send a test</button>}
    </div>
  );
}

// ── Guests ─────────────────────────────────────────────────────────────────

type Guest = { id: string; email: string; name: string; userId: string | null; channelIds: string[]; channels: string[]; expiresAt: string | null; acceptedAt: string | null; status: "invited" | "active" | "expired" | "deactivated" };

function ChannelChecks({ channels, picked, setPicked }: { channels: Channel[]; picked: string[]; setPicked: (x: string[]) => void }) {
  return (
    <div className="ch-picklist" style={{ maxHeight: 160 }}>
      {channels.map((c) => (
        <label key={c.id} className="ch-person">
          <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
          <span>{c.kind === "private" ? "🔒" : "#"} {c.name}</span>
        </label>
      ))}
    </div>
  );
}

export function GuestsDialog({ channels, onClose, flash }: { channels: Channel[]; onClose: () => void; flash: Flash }) {
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [form, setForm] = useState<{ email: string; name: string; channelIds: string[]; expiresAt: string; note: string } | null>(null);
  const [edit, setEdit] = useState<Guest | null>(null);
  const [n, setN] = useState(0);
  const chs = channels.filter((c) => c.kind !== "dm");
  useEffect(() => {
    api<{ guests: Guest[] }>("/chat/guests").then((d) => setGuests(d.guests), (e) => flash(e.message));
  }, [n, flash]);
  const reload = () => setN((x) => x + 1);
  const invite = async () => {
    if (!form) return;
    try {
      await api("/chat/guests", { body: { ...form, expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:00`).toISOString() : null } });
      flash(`Invitation sent to ${form.email}`);
      setForm(null);
      reload();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const patch = async (g: Guest, b: Record<string, unknown>, done: string) => {
    try {
      await api(`/chat/guests/${g.id}`, { method: "PATCH", body: b });
      flash(done);
      setEdit(null);
      reload();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  return (
    <Modal title="Guests" onClose={onClose} width={620}>
      {form ? (
        <div className="ch-form">
          <label className="ws-field"><span className="ws-label">Email</span><input className="ws-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="partner@othercompany.com" autoFocus /></label>
          <label className="ws-field"><span className="ws-label">Name (optional)</span><input className="ws-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <div className="ws-label">Channels they can use</div>
          <ChannelChecks channels={chs} picked={form.channelIds} setPicked={(channelIds) => setForm({ ...form, channelIds })} />
          <label className="ws-field" style={{ marginTop: 10 }}><span className="ws-label">Account ends (optional)</span><input className="ws-input" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></label>
          <label className="ws-field"><span className="ws-label">Note in the email (optional)</span><input className="ws-input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} /></label>
          <div className="ws-row"><span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="ws-btn primary" disabled={!form.email || !form.channelIds.length} onClick={invite}>Send invitation</button></div>
        </div>
      ) : edit ? (
        <div className="ch-form">
          <p style={{ marginTop: 0 }}><b>{edit.name || edit.email}</b> <span className="ws-muted">{edit.email}</span></p>
          <div className="ws-label">Channels</div>
          <ChannelChecks channels={chs} picked={edit.channelIds} setPicked={(channelIds) => setEdit({ ...edit, channelIds })} />
          <label className="ws-field" style={{ marginTop: 10 }}><span className="ws-label">Account ends</span><input className="ws-input" type="date" value={edit.expiresAt?.slice(0, 10) ?? ""} onChange={(e) => setEdit({ ...edit, expiresAt: e.target.value ? new Date(`${e.target.value}T23:59:00`).toISOString() : null })} /></label>
          <div className="ws-row">
            {edit.status === "deactivated"
              ? <button type="button" className="ws-btn" onClick={() => patch(edit, { deactivated: false }, "Reactivated")}>Reactivate</button>
              : <button type="button" className="ws-btn danger" onClick={() => patch(edit, { deactivated: true }, "Deactivated and signed out")}>Deactivate</button>}
            {edit.status !== "deactivated" && <button type="button" className="ws-btn" onClick={() => patch(edit, { resend: true }, "New link sent")}>Email a new link</button>}
            <span style={{ flex: 1 }} />
            <button type="button" className="ws-btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="ws-btn primary" onClick={() => patch(edit, { channelIds: edit.channelIds, expiresAt: edit.expiresAt }, "Saved")}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <p className="ws-muted" style={{ marginTop: 0 }}>People from other companies. They sign in with an emailed link and only see the channels you pick: no other channels, apps or directory.</p>
          <button type="button" className="ws-btn primary" onClick={() => setForm({ email: "", name: "", channelIds: [], expiresAt: "", note: "" })}><Plus size={14} /> Invite a guest</button>
          <div className="ch-rows" style={{ marginTop: 12 }}>
            {guests === null && <span className="ws-muted">Loading…</span>}
            {guests?.length === 0 && <span className="ws-muted">No guests yet.</span>}
            {guests?.map((g) => (
              <button key={g.id} type="button" className="ch-rowbtn" onClick={() => setEdit(g)}>
                <span><b>{g.name || g.email}</b> <small className="ws-muted">{g.email}</small><br /><small className="ws-muted">{g.channels.map((c) => `#${c}`).join(", ")}{g.expiresAt ? ` · until ${new Date(g.expiresAt).toLocaleDateString()}` : ""}</small></span>
                <span className={`ch-badge ${g.status}`}>{g.status}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Bots and workflows ─────────────────────────────────────────────────────

type BotRow = { id: string; userId: string; name: string; description: string; eventsUrl: string; commands: { command: string; description: string; usage: string }[]; disabled: boolean };
type Field = { key: string; label: string; type: "text" | "long" | "select"; options: string[] | string; required: boolean };
type Step = { type: "message" | "dm" | "task" | "react"; channelId?: string; text?: string; to?: string; projectId?: string; title?: string; assignee?: string; emoji?: string };
type Trigger = { type: "joined" | "keyword" | "reaction" | "schedule" | "shortcut"; channelId: string; keyword?: string; emoji?: string; time?: string; days?: number[]; tz?: string; fields?: Field[] };
type Wf = { id: string; name: string; enabled: boolean; trigger: Trigger; steps: Step[]; runs: number; lastRunAt: string | null; lastError: string | null; createdBy: string };

const TRIGGER_LABEL: Record<Trigger["type"], string> = {
  joined: "Someone joins a channel",
  keyword: "A message contains a keyword",
  reaction: "Someone reacts with an emoji",
  schedule: "On a schedule",
  shortcut: "Someone runs it from a channel (⚡)",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function AppsDialog({ boot, channels, onClose, flash, onChanged }: { boot: Boot; channels: Channel[]; onClose: () => void; flash: Flash; onChanged: () => void }) {
  const admin = !!boot.me.perms["teamchat.admin"];
  const [tab, setTab] = useState<"workflows" | "bots">("workflows");
  return (
    <Modal title="Apps and workflows" onClose={onClose} width={680}>
      <div className="ch-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "workflows"} className={tab === "workflows" ? "on" : ""} onClick={() => setTab("workflows")}><Zap size={13} /> Workflows</button>
        <button type="button" role="tab" aria-selected={tab === "bots"} className={tab === "bots" ? "on" : ""} onClick={() => setTab("bots")}><Bot size={13} /> Bots</button>
      </div>
      <div style={{ paddingTop: 12 }}>
        {tab === "workflows" ? <Workflows boot={boot} channels={channels} flash={flash} onChanged={onChanged} /> : <Bots admin={admin} flash={flash} onChanged={onChanged} />}
      </div>
    </Modal>
  );
}

function Bots({ admin, flash, onChanged }: { admin: boolean; flash: Flash; onChanged: () => void }) {
  const [bots, setBots] = useState<BotRow[] | null>(null);
  const [edit, setEdit] = useState<(Partial<BotRow> & { cmds: string }) | null>(null);
  const [secret, setSecret] = useState<{ token?: string; secret?: string } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    api<{ bots: BotRow[] }>("/chat/bots").then((d) => setBots(d.bots), (e) => flash(e.message));
  }, [n, flash]);
  const reload = () => {
    setN((x) => x + 1);
    onChanged();
  };
  const parseCmds = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [command, ...rest] = l.split(/\s+[—-]\s+|\s{2,}|\t/);
    return { command: command.replace(/^\//, ""), description: rest.join(" ") };
  });
  const save = async () => {
    if (!edit) return;
    try {
      const b = { name: edit.name, description: edit.description, eventsUrl: edit.eventsUrl, commands: parseCmds(edit.cmds) };
      if (edit.id) await api(`/chat/bots/${edit.id}`, { method: "PATCH", body: b });
      else setSecret(await api<{ token: string; secret: string }>("/chat/bots", { body: b }));
      setEdit(null);
      reload();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const act = async (b: BotRow, body: Record<string, unknown> | null) => {
    try {
      if (body) {
        const r = await api<{ token?: string }>(`/chat/bots/${b.id}`, { method: "PATCH", body });
        if (r.token) setSecret({ token: r.token });
      } else await api(`/chat/bots/${b.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  if (secret)
    return (
      <div className="ch-form">
        <p style={{ marginTop: 0 }}><b>Copy these now.</b> They won&apos;t be shown again.</p>
        {secret.token && <div className="ch-secret"><span className="ws-label">Bot token</span><code>{secret.token}</code><button type="button" className="ix-iconbtn" onClick={() => copy(secret.token!, flash)} aria-label="Copy token"><Copy size={14} /></button></div>}
        {secret.secret && <div className="ch-secret"><span className="ws-label">Signing secret</span><code>{secret.secret}</code><button type="button" className="ix-iconbtn" onClick={() => copy(secret.secret!, flash)} aria-label="Copy secret"><Copy size={14} /></button></div>}
        <BotDocs />
        <div className="ws-row"><span style={{ flex: 1 }} /><button type="button" className="ws-btn primary" onClick={() => setSecret(null)}>Done</button></div>
      </div>
    );
  if (edit)
    return (
      <div className="ch-form">
        <label className="ws-field"><span className="ws-label">Name</span><input className="ws-input" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
        <label className="ws-field"><span className="ws-label">What it does</span><input className="ws-input" value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
        <label className="ws-field"><span className="ws-label">Request URL (events and commands)</span><input className="ws-input" value={edit.eventsUrl ?? ""} onChange={(e) => setEdit({ ...edit, eventsUrl: e.target.value })} placeholder="https://bots.example.com/iotx" /></label>
        <label className="ws-field"><span className="ws-label">Slash commands, one per line: /command — description</span><textarea className="ws-textarea" rows={3} value={edit.cmds} onChange={(e) => setEdit({ ...edit, cmds: e.target.value })} placeholder={"/deploy — Deploy a branch\n/oncall — Who is on call"} /></label>
        <div className="ws-row"><span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setEdit(null)}>Cancel</button><button type="button" className="ws-btn primary" onClick={save} disabled={!edit.name?.trim()}>{edit.id ? "Save" : "Create bot"}</button></div>
      </div>
    );
  return (
    <>
      <p className="ws-muted" style={{ marginTop: 0 }}>Bots post with an API token, hear messages in the channels they&apos;re added to, and answer their own slash commands. Add one to a channel with /invite @name.</p>
      {admin ? <button type="button" className="ws-btn primary" onClick={() => setEdit({ cmds: "" })}><Plus size={14} /> New bot</button> : <small className="ws-muted">Only Chat admins can add bots.</small>}
      <div className="ch-rows" style={{ marginTop: 12 }}>
        {bots?.length === 0 && <span className="ws-muted">No bots yet.</span>}
        {bots?.map((b) => (
          <div key={b.id} className="ch-rowbtn" style={{ cursor: "default" }}>
            <span>
              <b>{b.name}</b> <span className="ch-app">APP</span>{b.disabled && <span className="ch-badge deactivated">off</span>}
              <br /><small className="ws-muted">{b.description || "No description"}{b.commands.length ? ` · ${b.commands.map((c) => `/${c.command}`).join(" ")}` : ""}</small>
            </span>
            {admin && (
              <span className="ws-row" style={{ margin: 0, flexWrap: "nowrap" }}>
                <button type="button" className="ws-btn" onClick={() => setEdit({ ...b, cmds: b.commands.map((c) => `/${c.command}${c.description ? ` — ${c.description}` : ""}`).join("\n") })}>Edit</button>
                <button type="button" className="ws-btn" onClick={() => act(b, { disabled: !b.disabled })}>{b.disabled ? "Turn on" : "Turn off"}</button>
                <button type="button" className="ws-btn" onClick={() => act(b, { rotate: true })}>New token</button>
                <button type="button" className="ix-iconbtn" onClick={() => act(b, null)} aria-label={`Delete ${b.name}`}><Trash2 size={14} /></button>
              </span>
            )}
          </div>
        ))}
      </div>
      <BotDocs />
    </>
  );
}

function BotDocs() {
  return (
    <details className="ch-docs">
      <summary>How bots connect</summary>
      <p><b>Post:</b> <code>POST /workspace/api/chat/bot/messages</code> with <code>Authorization: Bearer xbot-…</code> and <code>{"{ channel, text, thread? }"}</code>. Also <code>GET …/bot/messages?channel=</code>, <code>GET …/bot/channels</code>, <code>PATCH/DELETE …/bot/messages/&lt;id&gt;</code>.</p>
      <p><b>Events:</b> people&apos;s messages in the bot&apos;s channels and DMs are POSTed to the request URL as <code>{"{ type: \"event\", event: { type: \"message\" | \"app_mention\", channel, user, text, … } }"}</code>. Answer <code>{"{ text }"}</code> to reply.</p>
      <p><b>Commands:</b> <code>{"{ type: \"slash_command\", command, text, user, channel, response_url }"}</code>. Answer <code>{"{ text, response_type: \"in_channel\" }"}</code> (or ephemeral, the default), or POST to response_url within 30 minutes.</p>
      <p><b>Check requests:</b> <code>x-iotx-signature</code> = <code>v0=</code> + HMAC-SHA256(secret, <code>v0:&lt;x-iotx-timestamp&gt;:&lt;body&gt;</code>), hex.</p>
    </details>
  );
}

function Workflows({ boot, channels, flash, onChanged }: { boot: Boot; channels: Channel[]; flash: Flash; onChanged: () => void }) {
  const [list, setList] = useState<Wf[] | null>(null);
  const [edit, setEdit] = useState<Partial<Wf> & { trigger: Trigger; steps: Step[] } | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [n, setN] = useState(0);
  const mine = channels.filter((c) => c.kind !== "dm" && c.joined);
  useEffect(() => {
    api<{ workflows: Wf[] }>("/chat/workflows").then((d) => setList(d.workflows), (e) => flash(e.message));
  }, [n, flash]);
  useEffect(() => {
    if (boot.me.perms["tasks.open"]) api<{ projects: { id: string; name: string }[] }>("/tasks/projects").then((d) => setProjects(d.projects), () => {});
  }, [boot.me.perms]);
  const reload = () => {
    setN((x) => x + 1);
    onChanged();
  };
  const blank = (): Partial<Wf> & { trigger: Trigger; steps: Step[] } => ({ name: "", enabled: true, trigger: { type: "joined", channelId: mine[0]?.id ?? "", days: [1, 2, 3, 4, 5], time: "09:00", tz: boot.me.tz, fields: [] }, steps: [{ type: "message", channelId: "trigger", text: "Welcome {{user}}! 👋" }] });
  const save = async () => {
    if (!edit) return;
    const trigger = { ...edit.trigger, fields: (edit.trigger.fields ?? []).map((f) => ({ ...f, options: typeof f.options === "string" ? f.options.split(",") : f.options })) };
    try {
      if (edit.id) await api(`/chat/workflows/${edit.id}`, { method: "PATCH", body: { name: edit.name, trigger, steps: edit.steps, enabled: edit.enabled } });
      else await api("/chat/workflows", { body: { name: edit.name, trigger, steps: edit.steps } });
      flash("Workflow saved");
      setEdit(null);
      reload();
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const toggle = (w: Wf) => api(`/chat/workflows/${w.id}`, { method: "PATCH", body: { enabled: !w.enabled } }).then(reload, (e) => flash(e.message));
  const del = (w: Wf) => api(`/chat/workflows/${w.id}`, { method: "DELETE" }).then(reload, (e) => flash(e.message));
  const chName = (id: string) => (id === "trigger" ? "the same channel" : `#${channels.find((c) => c.id === id)?.name ?? "?"}`);

  if (edit) {
    const t = edit.trigger;
    const setT = (x: Partial<Trigger>) => setEdit({ ...edit, trigger: { ...t, ...x } });
    const setStep = (i: number, x: Partial<Step>) => setEdit({ ...edit, steps: edit.steps.map((s, j) => (j === i ? { ...s, ...x } : s)) });
    const vars = ["{{user}}", "{{channel}}", "{{date}}", ...(["keyword", "reaction"].includes(t.type) ? ["{{message}}"] : []), ...(t.fields ?? []).map((f) => `{{form.${f.key}}}`)];
    return (
      <div className="ch-form wf-edit">
        <label className="ws-field"><span className="ws-label">Name</span><input className="ws-input" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Welcome new people" autoFocus /></label>
        <div className="ws-label">When</div>
        <div className="ws-row">
          <select className="ws-select" value={t.type} onChange={(e) => setT({ type: e.target.value as Trigger["type"] })} aria-label="Trigger">
            {Object.entries(TRIGGER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="ws-select" value={t.channelId} onChange={(e) => setT({ channelId: e.target.value })} aria-label="Channel">
            {t.type === "schedule" && <option value="">(no channel)</option>}
            {mine.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>
        {t.type === "keyword" && <input className="ws-input" value={t.keyword ?? ""} onChange={(e) => setT({ keyword: e.target.value })} placeholder="Keyword or phrase, e.g. help" aria-label="Keyword" />}
        {t.type === "reaction" && <input className="ws-input" value={t.emoji ?? ""} onChange={(e) => setT({ emoji: e.target.value })} placeholder="Emoji, e.g. ✅" aria-label="Emoji" style={{ maxWidth: 160 }} />}
        {t.type === "schedule" && (
          <div className="ws-row">
            <input className="ws-input" type="time" value={t.time ?? "09:00"} onChange={(e) => setT({ time: e.target.value })} aria-label="Time" style={{ maxWidth: 130 }} />
            {DAYS.map((d, i) => (
              <label key={d} className="ch-day"><input type="checkbox" checked={!!t.days?.includes(i)} onChange={(e) => setT({ days: e.target.checked ? [...(t.days ?? []), i] : (t.days ?? []).filter((x) => x !== i) })} /> {d}</label>
            ))}
            <small className="ws-muted">{t.tz}</small>
          </div>
        )}
        {t.type === "shortcut" && (
          <div className="wf-fields">
            <div className="ws-label">Form (optional)</div>
            {(t.fields ?? []).map((f, i) => (
              <div key={i} className="ws-row" style={{ flexWrap: "nowrap" }}>
                <input className="ws-input" value={f.label} onChange={(e) => setT({ fields: t.fields!.map((x, j) => (j === i ? { ...x, label: e.target.value, key: x.key || `f${i + 1}` } : x)) })} placeholder="Question" aria-label="Question" />
                <select className="ws-select" value={f.type} onChange={(e) => setT({ fields: t.fields!.map((x, j) => (j === i ? { ...x, type: e.target.value as Field["type"] } : x)) })} aria-label="Answer type" style={{ maxWidth: 130 }}>
                  <option value="text">Short answer</option><option value="long">Paragraph</option><option value="select">Choice</option>
                </select>
                {f.type === "select" && <input className="ws-input" value={Array.isArray(f.options) ? f.options.join(",") : f.options} onChange={(e) => setT({ fields: t.fields!.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)) })} placeholder="a,b,c" aria-label="Options" />}
                <label className="ch-day"><input type="checkbox" checked={f.required} onChange={(e) => setT({ fields: t.fields!.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} /> required</label>
                <button type="button" className="ix-iconbtn" onClick={() => setT({ fields: t.fields!.filter((_, j) => j !== i) })} aria-label="Remove question"><X size={14} /></button>
              </div>
            ))}
            <button type="button" className="ws-btn" onClick={() => setT({ fields: [...(t.fields ?? []), { key: `f${(t.fields?.length ?? 0) + 1}`, label: "", type: "text", options: [], required: false }] })}><Plus size={13} /> Question</button>
          </div>
        )}
        <div className="ws-label" style={{ marginTop: 12 }}>Then</div>
        {edit.steps.map((s, i) => (
          <div key={i} className="wf-step">
            <b>{i + 1}.</b>
            {s.type === "message" && (
              <>
                <span>Post in</span>
                <select className="ws-select" value={s.channelId} onChange={(e) => setStep(i, { channelId: e.target.value })} aria-label="Post in">
                  {t.type !== "schedule" || t.channelId ? <option value="trigger">the same channel</option> : null}
                  {mine.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </select>
                <textarea className="ws-textarea" rows={2} value={s.text} onChange={(e) => setStep(i, { text: e.target.value })} aria-label="Message" />
              </>
            )}
            {s.type === "dm" && (
              <>
                <span>Message</span>
                <select className="ws-select" value={s.to} onChange={(e) => setStep(i, { to: e.target.value })} aria-label="Send to">
                  {t.type !== "schedule" && <option value="trigger_user">the person who started it</option>}
                  {boot.people.filter((p) => !/^(bot|wf|guest)_/.test(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <textarea className="ws-textarea" rows={2} value={s.text} onChange={(e) => setStep(i, { text: e.target.value })} aria-label="Direct message" />
              </>
            )}
            {s.type === "task" && (
              <>
                <span>Create a task in</span>
                <select className="ws-select" value={s.projectId} onChange={(e) => setStep(i, { projectId: e.target.value })} aria-label="Project">
                  <option value="">Pick a project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input className="ws-input" value={s.title ?? ""} onChange={(e) => setStep(i, { title: e.target.value })} placeholder="Task title" aria-label="Task title" />
                {t.type !== "schedule" && <label className="ch-day"><input type="checkbox" checked={s.assignee === "trigger_user"} onChange={(e) => setStep(i, { assignee: e.target.checked ? "trigger_user" : "" })} /> assign to them</label>}
              </>
            )}
            {s.type === "react" && (
              <>
                <span>React to the message with</span>
                <input className="ws-input" value={s.emoji ?? ""} onChange={(e) => setStep(i, { emoji: e.target.value })} aria-label="Reaction emoji" style={{ maxWidth: 120 }} />
              </>
            )}
            <button type="button" className="ix-iconbtn" onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, j) => j !== i) })} aria-label={`Remove step ${i + 1}`}><X size={14} /></button>
          </div>
        ))}
        <div className="ws-row">
          <span className="ws-muted">Add a step:</span>
          <button type="button" className="ws-btn" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { type: "message", channelId: t.channelId ? "trigger" : mine[0]?.id, text: "" }] })}>Message</button>
          <button type="button" className="ws-btn" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { type: "dm", to: t.type === "schedule" ? boot.me.id : "trigger_user", text: "" }] })}>Direct message</button>
          {boot.me.perms["tasks.create"] && <button type="button" className="ws-btn" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { type: "task", projectId: "", title: "", assignee: "" }] })}>Task</button>}
          {["keyword", "reaction"].includes(t.type) && <button type="button" className="ws-btn" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { type: "react", emoji: "👀" }] })}>Reaction</button>}
        </div>
        <small className="ws-muted">You can use {vars.join(" ")} in text.</small>
        <div className="ws-row" style={{ marginTop: 10 }}><span style={{ flex: 1 }} /><button type="button" className="ws-btn" onClick={() => setEdit(null)}>Cancel</button><button type="button" className="ws-btn primary" onClick={save} disabled={!edit.name?.trim() || !edit.steps.length}>Save workflow</button></div>
      </div>
    );
  }
  return (
    <>
      <p className="ws-muted" style={{ marginTop: 0 }}>Automate the routine: welcome people, answer keywords, collect requests with a form, post reminders on a schedule, or turn a ✅ into a task.</p>
      {boot.me.guest ? <small className="ws-muted">Guests can&apos;t build workflows.</small> : <button type="button" className="ws-btn primary" onClick={() => setEdit(blank())} disabled={!mine.length}><Plus size={14} /> New workflow</button>}
      <div className="ch-rows" style={{ marginTop: 12 }}>
        {list?.length === 0 && <span className="ws-muted">No workflows yet.</span>}
        {list?.map((w) => (
          <div key={w.id} className="ch-rowbtn" style={{ cursor: "default" }}>
            <span>
              <b>{w.name}</b>{!w.enabled && <span className="ch-badge deactivated">off</span>}
              <br /><small className="ws-muted">{TRIGGER_LABEL[w.trigger.type]}{w.trigger.channelId ? ` in ${chName(w.trigger.channelId)}` : ""} · {w.steps.length} step{w.steps.length === 1 ? "" : "s"} · ran {w.runs}×</small>
              {w.lastError && <><br /><small className="ws-error">Last run: {w.lastError}</small></>}
            </span>
            <span className="ws-row" style={{ margin: 0, flexWrap: "nowrap" }}>
              <button type="button" className="ws-btn" onClick={() => setEdit({ ...w, trigger: { ...w.trigger, fields: w.trigger.fields ?? [] } })}>Edit</button>
              <button type="button" className="ws-btn" onClick={() => toggle(w)}>{w.enabled ? "Turn off" : "Turn on"}</button>
              <button type="button" className="ix-iconbtn" onClick={() => del(w)} aria-label={`Delete ${w.name}`}><Trash2 size={14} /></button>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Shortcuts (⚡ in a channel) ─────────────────────────────────────────────

export type Shortcut = { id: string; name: string; fields: Field[] };

export function ShortcutDialog({ wf, channelId, onClose, flash }: { wf: Shortcut; channelId: string; onClose: () => void; flash: Flash }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api(`/chat/workflows/${wf.id}`, { body: { channelId, form } });
      flash(`${wf.name}: done`);
      onClose();
    } catch (e) {
      flash((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Modal title={<><Zap size={15} /> {wf.name}</>} onClose={onClose} width={460} label={wf.name}
      footer={<><button type="button" className="ws-btn" onClick={onClose}>Cancel</button><button type="button" className="ws-btn primary" onClick={run} disabled={busy}>{wf.fields.length ? "Submit" : "Run"}</button></>}>
      {!wf.fields.length && <p style={{ margin: 0 }}>Run this workflow now?</p>}
      {wf.fields.map((f) => (
        <label key={f.key} className="ws-field">
          <span className="ws-label">{f.label}{f.required ? " *" : ""}</span>
          {f.type === "long" ? <textarea className="ws-textarea" rows={3} value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            : f.type === "select" ? (
              <select className="ws-select" value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>
                <option value="">Choose…</option>
                {(Array.isArray(f.options) ? f.options : []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : <input className="ws-input" value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />}
        </label>
      ))}
    </Modal>
  );
}

/** Command answers only the sender sees. */
export function Ephemeral({ notes, onDismiss }: { notes: { id: string; text: string; from: string }[]; onDismiss: (id: string) => void }) {
  if (!notes.length) return null;
  return (
    <div className="ch-ephemeral">
      {notes.map((n) => (
        <div key={n.id} className="ch-eph">
          <small className="ws-muted"><Bot size={12} /> {n.from} · only visible to you</small>
          <div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>
          <button type="button" className="ix-iconbtn" onClick={() => onDismiss(n.id)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}
