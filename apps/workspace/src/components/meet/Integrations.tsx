"use client";
import { useCallback, useEffect, useState } from "react";
import { Bot, CalendarDays, Copy, Download, KeyRound, ListChecks, Mail, MessagesSquare, Puzzle, Send, Trash2, Webhook } from "lucide-react";
import { meetApi } from "./api";

type Token = { id: string; name: string; kind: "extension" | "api"; hint: string; createdAt: string; lastUsedAt: string | null; pairing: boolean };
type Hook = { id: string; url: string; events: string[]; active: boolean; createdAt: string; secretHint: string };
type Delivery = { id: string; target: string; event: string; ok: boolean; status: number; detail: string; ms: number; test: boolean; createdAt: string; meeting: { title: string; code: string } | null };
type Settings = { chatChannelId: string | null; tasksProjectId: string | null; kbSuggest: boolean; calendarWriteback: boolean; emailRecap: string };
type Data = { settings: Settings; workspaceRecap: string; webhooks: Hook[]; deliveries: Delivery[] };
type Made = { kind: "extension" | "api"; token: string; pairCode: string | null; pairUntil: string | null };

const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "never");
const TARGET: Record<string, string> = { webhook: "Webhook", chat: "Chat", tasks: "Tasks", kb: "Knowledge base", calendar: "Calendar", email: "Email recap", all: "Integrations" };
const RECAP: Record<string, string> = { attendees: "attendees", invitees: "invitees", me: "only me" };

function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="mt-btn sm" onClick={async () => { await navigator.clipboard?.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1800); }}>
      <Copy size={13} /> {done ? "Copied" : label}
    </button>
  );
}

/** Meet → Integrations: browser extension, MCP, webhooks, and what happens when a report is ready. */
export default function Integrations({ canChat, canTasks, canRecord }: { canChat: boolean; canTasks: boolean; canRecord: boolean }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [data, setData] = useState<Data | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [channels, setChannels] = useState<{ id: string; name: string; kind: string; joined: boolean }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string; key: string }[]>([]);
  const [made, setMade] = useState<Made | null>(null);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const load = useCallback(async () => {
    const [t, d] = await Promise.all([meetApi<{ tokens: Token[] }>("/tokens"), meetApi<Data>("/integrations")]);
    setTokens(t.tokens);
    setData(d);
    setForm((f) => f ?? d.settings);
  }, []);

  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
    if (canChat) fetch("/workspace/api/chat/channels", { cache: "no-store" }).then((r) => r.json()).then((d) => setChannels((d.channels ?? []).filter((c: { kind: string; joined: boolean }) => c.kind !== "dm" && c.joined))).catch(() => {});
    if (canTasks) fetch("/workspace/api/tasks/projects", { cache: "no-store" }).then((r) => r.json()).then((d) => setProjects(d.projects ?? [])).catch(() => {});
  }, [load, canChat, canTasks]);

  const act = async (fn: () => Promise<unknown>, ok = "") => {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const newToken = (kind: "extension" | "api") =>
    act(async () => {
      const d = await meetApi<{ token: string; pairCode: string | null; pairUntil: string | null }>("/tokens", { body: { kind } });
      setMade({ kind, token: d.token, pairCode: d.pairCode, pairUntil: d.pairUntil });
    });

  const save = () => act(() => meetApi("/integrations", { method: "PUT", body: form }), "Saved. These run for every meeting you host, when its report is ready.");

  const ext = tokens.filter((t) => t.kind === "extension");
  const api = tokens.filter((t) => t.kind === "api");
  const mcpUrl = `${origin}/workspace/api/mcp`;

  const tokenList = (list: Token[]) =>
    list.length === 0 ? null : (
      <div className="mt-list">
        {list.map((t) => (
          <div key={t.id} className="mt-row">
            <span className="t">{t.name} <span className="mt-note">· {t.hint}… · made {ago(t.createdAt)} · last used {ago(t.lastUsedAt)}{t.pairing ? " · waiting for pairing" : ""}</span></span>
            <button className="mt-btn sm danger" disabled={busy} onClick={() => act(() => meetApi(`/tokens/${t.id}`, { method: "DELETE" }), "Revoked. That extension or client is signed out.")}><Trash2 size={13} /> Revoke</button>
          </div>
        ))}
      </div>
    );

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div className="mt-notes">
        <div>
          <a className="mt-note" href="/workspace/meet">← Meet</a>
          <h1 style={{ margin: "6px 0 4px", fontSize: 22 }}>Integrations</h1>
          <p className="mt-note" style={{ margin: 0 }}>Notes for calls on Google Meet, Zoom and Teams, and where your meeting reports go when they&rsquo;re ready.</p>
        </div>
        {err && <p className="mt-error">{err}</p>}
        {msg && <p className="mt-note" role="status">{msg}</p>}

        {made && (
          <section className="mt-card" style={{ borderColor: "var(--accent)" }}>
            <h2><KeyRound size={15} style={{ verticalAlign: -2 }} /> {made.kind === "extension" ? "Connect the extension" : "Your API token"}</h2>
            {made.pairCode && (
              <>
                <p className="mt-note" style={{ marginTop: 0 }}>In the extension, choose &ldquo;Sign in&rdquo; and enter this code (it works once, until {new Date(made.pairUntil!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}):</p>
                <div className="mt-actions"><code style={{ fontSize: 26, letterSpacing: 4, fontWeight: 700 }}>{made.pairCode}</code><CopyBtn text={made.pairCode} /></div>
                <p className="mt-note">Server address for the extension: <code>{origin}</code></p>
                <p className="mt-note">Or paste this token into the extension instead. It is shown only now; pairing with the code replaces it.</p>
              </>
            )}
            {!made.pairCode && <p className="mt-note" style={{ marginTop: 0 }}>Copy it now: it is shown only once. Anyone with it can read the meeting reports you can see.</p>}
            <div className="mt-actions"><code className="mt-pill" style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{made.token}</code><CopyBtn text={made.token} /></div>
            <div className="mt-actions" style={{ marginTop: 8 }}><button className="mt-btn sm" onClick={() => setMade(null)}>Done</button></div>
          </section>
        )}

        <section className="mt-card">
          <h2><Puzzle size={15} style={{ verticalAlign: -2 }} /> Browser extension: notes for Google Meet, Zoom and Teams</h2>
          <p className="mt-note" style={{ marginTop: 0 }}>
            No bot joins your call. The extension records the call&rsquo;s sound in your browser (the tab, plus your microphone if you allow it) while a &ldquo;Recording for notes&rdquo; badge shows on the page, then the report appears here in Meet.
            {canRecord ? "" : " Your role can't use AI notes, so recording is off for you."}
          </p>
          <div className="mt-actions">
            <a className="mt-btn sm" href="/workspace/read-extension.zip" download><Download size={13} /> Download the extension</a>
            <button className="mt-btn sm primary" disabled={busy} onClick={() => newToken("extension")}>Connect browser extension</button>
          </div>
          <p className="mt-note">Install: unzip it, open chrome://extensions, turn on Developer mode, choose &ldquo;Load unpacked&rdquo; and pick the folder.</p>
          {tokenList(ext)}
        </section>

        <section className="mt-card">
          <h2><Bot size={15} style={{ verticalAlign: -2 }} /> Claude, ChatGPT and other AI apps (MCP)</h2>
          <p className="mt-note" style={{ marginTop: 0 }}>Let an AI assistant search your meetings, read reports and list action items. Add a custom connector (remote MCP server) with this address and an API token as the Bearer token.</p>
          <div className="mt-actions"><code className="mt-pill">{mcpUrl}</code><CopyBtn text={mcpUrl} /><button className="mt-btn sm primary" disabled={busy} onClick={() => newToken("api")}>New API token</button></div>
          <p className="mt-note">Tools: search_meetings, get_report, list_action_items. It only sees reports you can see.</p>
          {tokenList(api)}
        </section>

        {form && data && (
          <section className="mt-card" style={{ display: "grid", gap: 10 }}>
            <h2 style={{ marginBottom: 0 }}>When a report is ready</h2>
            <p className="mt-note" style={{ margin: 0 }}>For every meeting you host, including calls recorded with the extension.</p>
            <label style={{ display: "grid", gap: 4 }}>
              <span><MessagesSquare size={14} style={{ verticalAlign: -2 }} /> Post the summary in a Chat channel</span>
              <select className="mt-input" disabled={!canChat} value={form.chatChannelId ?? ""} onChange={(e) => setForm({ ...form, chatChannelId: e.target.value || null })}>
                <option value="">Don&rsquo;t post</option>
                {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span><ListChecks size={14} style={{ verticalAlign: -2 }} /> Turn action items into tasks</span>
              <select className="mt-input" disabled={!canTasks} value={form.tasksProjectId ?? ""} onChange={(e) => setForm({ ...form, tasksProjectId: e.target.value || null })}>
                <option value="">Don&rsquo;t make tasks</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
              </select>
            </label>
            <label className="mt-check"><input type="checkbox" checked={form.kbSuggest} onChange={(e) => setForm({ ...form, kbSuggest: e.target.checked })} /> <span>Suggest the decisions to the knowledge base <span className="mt-note">(a reviewer approves them in Knowledge)</span></span></label>
            <label className="mt-check"><input type="checkbox" checked={form.calendarWriteback} onChange={(e) => setForm({ ...form, calendarWriteback: e.target.checked })} /> <span><CalendarDays size={14} style={{ verticalAlign: -2 }} /> Add the summary and a link to the calendar event&rsquo;s description</span></label>
            <label style={{ display: "grid", gap: 4 }}>
              <span><Mail size={14} style={{ verticalAlign: -2 }} /> Email a recap</span>
              <select className="mt-input" value={form.emailRecap} onChange={(e) => setForm({ ...form, emailRecap: e.target.value })}>
                <option value="off">Don&rsquo;t email</option>
                <option value="workspace">As Meet&rsquo;s sharing setting says (now: {RECAP[data.workspaceRecap] ?? data.workspaceRecap})</option>
                <option value="attendees">To the people who attended</option>
                <option value="invitees">To everyone invited</option>
                <option value="me">Only to me</option>
              </select>
            </label>
            <div className="mt-actions"><button className="mt-btn primary" disabled={busy} onClick={save}>Save</button></div>
          </section>
        )}

        {data && (
          <section className="mt-card">
            <h2><Webhook size={15} style={{ verticalAlign: -2 }} /> Webhooks</h2>
            <p className="mt-note" style={{ marginTop: 0 }}>
              We POST <code>report.ready</code> with the report as JSON. Each request is signed: <code>x-iotx-signature</code> = &ldquo;v0=&rdquo; + HMAC-SHA256(secret, &ldquo;v0:&lt;x-iotx-timestamp&gt;:&lt;body&gt;&rdquo;).
            </p>
            <form className="mt-actions" onSubmit={(e) => { e.preventDefault(); act(async () => { const d = await meetApi<{ webhook: Hook; secret: string }>("/webhooks", { body: { url: hookUrl } }); setSecret({ id: d.webhook.id, secret: d.secret }); setHookUrl(""); }); }}>
              <input className="mt-input" style={{ flex: 1, minWidth: 220 }} placeholder="https://example.com/hooks/meetings" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} aria-label="Webhook URL" />
              <button className="mt-btn sm primary" disabled={busy || !hookUrl.trim()}>Add webhook</button>
            </form>
            {secret && (
              <p className="mt-note">Signing secret (shown once): <code>{secret.secret}</code> <CopyBtn text={secret.secret} /></p>
            )}
            <div className="mt-list">
              {data.webhooks.map((h) => (
                <div key={h.id} className="mt-row" style={{ flexWrap: "wrap" }}>
                  <span className="t">{h.url} <span className="mt-note">· {h.secretHint}{h.active ? "" : " · paused"}</span></span>
                  <button className="mt-btn sm" disabled={busy} onClick={() => act(async () => { const d = await meetApi<{ delivery: Delivery }>(`/webhooks/${h.id}/test`, { method: "POST" }); setMsg(d.delivery.ok ? `Test delivered (${d.delivery.status}, ${d.delivery.ms} ms).` : `Test failed: ${d.delivery.detail}`); })}><Send size={13} /> Test</button>
                  <button className="mt-btn sm" disabled={busy} onClick={() => act(() => meetApi(`/webhooks/${h.id}`, { method: "PATCH", body: { active: !h.active } }))}>{h.active ? "Pause" : "Resume"}</button>
                  <button className="mt-btn sm" disabled={busy} onClick={() => act(async () => { const d = await meetApi<{ secret: string }>(`/webhooks/${h.id}`, { method: "PATCH", body: { rotate: true } }); setSecret({ id: h.id, secret: d.secret }); })}>New secret</button>
                  <button className="mt-btn sm danger" disabled={busy} onClick={() => act(() => meetApi(`/webhooks/${h.id}`, { method: "DELETE" }))}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </section>
        )}

        {data && (
          <section className="mt-card">
            <h2>Delivery log</h2>
            {data.deliveries.length === 0 ? (
              <p className="mt-note">Nothing sent yet.</p>
            ) : (
              <div className="mt-list">
                {data.deliveries.map((d) => (
                  <div key={d.id} className="mt-row" title={d.detail}>
                    <span className="when">{ago(d.createdAt)}</span>
                    <span className="t">
                      <span style={{ color: d.ok ? "var(--ws-ok, #22a06b)" : "var(--ws-danger)" }}>{d.ok ? "✓" : "✕"}</span> {TARGET[d.target] ?? d.target}{d.test ? " (test)" : ""}
                      {d.meeting ? <> · <a href={`/workspace/meet/${d.meeting.code}/notes`}>{d.meeting.title}</a></> : null}
                      <span className="mt-note"> · {d.detail}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
