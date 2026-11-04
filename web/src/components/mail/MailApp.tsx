"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePerms } from "@/components/iotx/PermsProvider";
import { useBrand } from "@/components/BrandProvider";
import { Icon } from "@/components/iotx/icons";
import MailboxForm from "./MailboxForm";
import RecipientField, { type Contact } from "./RecipientField";
import RichEditor, { type RichEditorHandle } from "./RichEditor";
import { checkRecipient, formatRecipient, forwardBlock, problemText, quoteBlock, textToHtml, type Recipient } from "@/lib/mail/compose";

type Box = { id: string; email: string; displayName: string | null; ownerId: string | null; authType: string; status: string; lastError: string | null };
type Folder = { path: string; name: string; role: string | null; unseen?: number };
type Row = { id: string; fromAddr: string; fromName: string | null; subject: string; snippet: string | null; date: string; seen: boolean; flagged: boolean; hasAttachments: boolean; aiLabel: string | null };
type Addr = { name: string | null; address: string };
type Full = Row & { to: Addr[]; cc: Addr[] | null; html: string | null; text: string | null; attachments: { part?: string; filename?: string; size?: number }[] | null; aiSummary: string | null; messageId: string | null };
/** html is the editor's starting content; the editor owns it after that. */
type Draft = { key: number; to: Recipient[]; cc: Recipient[]; bcc: Recipient[]; showCc: boolean; showBcc: boolean; subject: string; html: string; replyTo?: string; forward?: boolean };

const LABEL_COLOR: Record<string, string> = {
  enquiry: "#2563eb", quotation: "#7c3aed", "purchase order": "#0f766e", invoice: "#b45309", payment: "#15803d",
  delivery: "#0891b2", complaint: "#dc2626", internal: "#64748b", newsletter: "#94a3b8", other: "#94a3b8",
};

const when = (d: string) => {
  const t = new Date(d);
  const now = new Date();
  return t.toDateString() === now.toDateString() ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t.toLocaleDateString([], { day: "numeric", month: "short" });
};

/** The Mail app: every mailbox the person may use, read and sent inside IOTx, with AI help. */
export default function MailApp() {
  const perms = usePerms();
  const brand = useBrand();
  const canAi = perms.can("mail.ai");
  const canSend = perms.can("mail.send");
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [canConnect, setCanConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [box, setBox] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState("INBOX");
  const [rows, setRows] = useState<Row[]>([]);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Full | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [contacts, setContacts] = useState<{ box: string; contacts: Contact[]; domains: string[] } | null>(null);
  const editor = useRef<RichEditorHandle>(null);
  const draftKey = useRef(0);

  const api = (params: Record<string, string>) => `/api/mail?${new URLSearchParams({ mailbox: box ?? "", ...params })}`;
  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const r = await fetch("/api/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mailbox: box, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Something went wrong.");
      return d;
    },
    [box],
  );

  const loadBoxes = useCallback(
    () =>
      fetch("/api/mail/mailboxes")
        .then((r) => r.json())
        .then((d) => {
          setBoxes(d.mine ?? []);
          setCanConnect(!!d.canConnect);
          const fromUrl = new URLSearchParams(window.location.search).get("mailbox");
          setBox((cur) => cur ?? (fromUrl && d.mine?.some((b: Box) => b.id === fromUrl) ? fromUrl : null) ?? d.mine?.[0]?.id ?? null);
        }),
    [],
  );
  useEffect(() => {
    void loadBoxes().then(() => {
      const e = new URLSearchParams(window.location.search).get("mail_error");
      if (e) setError(e);
    });
  }, [loadBoxes]);

  /** A different mailbox or folder: clear the old list first so it never looks like the new one. */
  const goTo = (b: string | null, f: string) => {
    setRows([]);
    setOpen(null);
    setMore(false);
    setLoading(true);
    setError(null);
    setBox(b);
    setFolder(f);
  };

  /** Callers show the spinner (setLoading(true)) first; this only fetches and fills the list. */
  const loadList = useCallback(
    (opts: { append?: boolean } = {}) => {
      if (!box) return Promise.resolve();
      const before = opts.append && rows.length ? rows[rows.length - 1].date : "";
      return fetch(api({ view: "messages", folder, q, ...(before ? { before } : {}) })).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        setLoading(false);
        if (!r.ok) return setError(d.error ?? "Couldn't load mail.");
        setRows((cur) => (opts.append ? [...cur, ...d.messages] : d.messages));
        setMore(!!d.more);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [box, folder, q, rows],
  );

  useEffect(() => {
    if (!box) return;
    fetch(api({ view: "folders" }))
      .then((r) => r.json())
      .then((d) => setFolders(d.folders ?? []))
      .catch(() => setFolders([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box]);

  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, folder]);

  async function openRow(id: string) {
    setOpen(null);
    setBusy("open");
    setError(null);
    const r = await fetch(api({ view: "message", id }));
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setError(d.error ?? "Couldn't open that message.");
    setOpen(d.message);
    setRows((cur) => cur.map((x) => (x.id === id ? { ...x, seen: true } : x)));
  }

  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!open) return;
    setBusy(action);
    setError(null);
    try {
      const d = await post({ action, id: open.id, ...extra });
      if (action === "summarize") setOpen({ ...open, aiSummary: d.summary });
      if (action === "classify") {
        setOpen({ ...open, aiLabel: d.label });
        setRows((cur) => cur.map((x) => (x.id === open.id ? { ...x, aiLabel: d.label } : x)));
      }
      if (action === "draft") compose({ to: [{ name: open.fromName, address: open.fromAddr }], subject: reSubject(open.subject), html: `${textToHtml(String(d.draft ?? ""))}<div><br></div>${quoteBlock(open)}`, replyTo: open.id });
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  const reload = (opts: { append?: boolean } = {}) => {
    setLoading(true);
    setError(null);
    return loadList(opts);
  };

  async function sync() {
    setBusy("sync");
    try {
      await post({ action: "sync", folder });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  async function sortVisible() {
    setBusy("sort");
    try {
      const ids = rows.filter((r) => !r.aiLabel).slice(0, 20).map((r) => r.id);
      const d = await post({ action: "sort", ids });
      setRows((cur) => cur.map((x) => (d.labels[x.id] ? { ...x, aiLabel: d.labels[x.id] } : x)));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  /** Open the compose window (and fetch who to suggest in To / Cc / Bcc, once per mailbox). */
  function compose(d: Partial<Draft>) {
    draftKey.current += 1;
    setError(null);
    setDraft({ key: draftKey.current, to: [], cc: [], bcc: [], showCc: !!d.cc?.length, showBcc: false, subject: "", html: "", ...d });
    if (box && contacts?.box !== box) {
      const forBox = box;
      fetch(api({ view: "contacts" }))
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => c && setContacts({ box: forBox, contacts: c.contacts ?? [], domains: c.domains ?? [] }))
        .catch(() => undefined);
    }
  }

  const domains = useMemo(() => {
    const own = boxes?.find((b) => b.id === box)?.email.split("@")[1];
    const known = contacts?.domains ?? [];
    return own ? [own, ...known.filter((d) => d !== own)] : known;
  }, [contacts, box, boxes]);

  async function send() {
    if (!draft) return;
    const all = [...draft.to, ...draft.cc, ...draft.bcc];
    if (!all.length) return setError("Add at least one recipient.");
    const bad = all.map((r) => checkRecipient(r, domains)).find((r) => !r.ok);
    if (bad) return setError(problemText(bad));
    const html = editor.current?.html() ?? "";
    setBusy("send");
    setError(null);
    try {
      const list = (rs: Recipient[]) => rs.map(formatRecipient).join(", ");
      await post({ action: "send", to: list(draft.to), cc: list(draft.cc), bcc: list(draft.bcc), subject: draft.subject, html, replyTo: draft.replyTo });
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  const reSubject = (s: string) => (/^re:/i.test(s) ? s : `Re: ${s}`);
  const reply = (all = false) => {
    if (!open) return;
    const me = current?.email.toLowerCase();
    const cc = all ? [...(open.to ?? []), ...(open.cc ?? [])].filter((a) => a.address && a.address.toLowerCase() !== me && a.address.toLowerCase() !== open.fromAddr.toLowerCase()) : [];
    compose({
      to: [{ name: open.fromName, address: open.fromAddr }],
      cc: cc.map((a) => ({ name: a.name, address: a.address })),
      subject: reSubject(open.subject),
      html: `<div><br></div><div><br></div>${quoteBlock(open)}`,
      replyTo: open.id,
    });
  };
  const forward = () =>
    open &&
    compose({
      subject: /^fwd?:/i.test(open.subject) ? open.subject : `Fwd: ${open.subject}`,
      html: `<div><br></div><div><br></div>${forwardBlock(open)}`,
      forward: true,
    });

  const current = boxes?.find((b) => b.id === box) ?? null;
  const srcDoc = useMemo(() => {
    if (!open) return "";
    const body = open.html ?? `<pre style="white-space:pre-wrap;font:14px/1.6 system-ui">${(open.text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px 20px;font:14px/1.6 system-ui,sans-serif;color:#1f2330;background:#fff;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${body}</body></html>`;
  }, [open]);

  const muted = { color: "var(--ix-muted)" };
  const btn = "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50";

  // ── No mailbox yet ──
  if (boxes && boxes.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-6 py-14">
        <span className="grid h-12 w-12 place-items-center rounded-full text-white" style={{ background: "linear-gradient(135deg,#dc2626,#f87171)" }}>
          <Icon name="mail" size={22} />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Bring your mail into {brand.shortName}</h1>
        <p className="mt-2 text-sm" style={muted}>
          Connect your mailbox to read, reply and send from here, with {brand.shortName} summarizing long threads, drafting replies and sorting enquiries, orders and invoices. Your mail stays with your email provider.
        </p>
        <div className="mt-6 rounded-xl border p-5" style={{ background: "var(--ix-panel)" }}>
          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
          {canConnect ? (
            <MailboxForm onDone={() => void loadBoxes()} />
          ) : (
            <p className="text-sm" style={muted}>
              Connecting your own mailbox isn&rsquo;t turned on for your role. Ask an admin to connect it for you, or to give you access to a shared mailbox.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0" style={{ color: "var(--ix-ink)", height: "calc(100vh - 70px)" }}>
      {/* Mailboxes and folders */}
      <aside className="hidden w-56 flex-none flex-col gap-1 overflow-y-auto border-r p-3 md:flex" style={{ borderColor: "var(--ix-line)" }}>
        {canSend && current && (
          <button type="button" className="mb-2 rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} onClick={() => compose({})}>
            Compose
          </button>
        )}
        <label className="text-xs font-medium uppercase tracking-wider" style={muted} htmlFor="mailbox-pick">Mailbox</label>
        <select id="mailbox-pick" className="mb-2 w-full rounded-lg border bg-transparent px-2 py-1.5 text-sm" value={box ?? ""} onChange={(e) => goTo(e.target.value, "INBOX")}>
          {boxes?.map((b) => (
            <option key={b.id} value={b.id}>{b.email}{b.ownerId ? "" : " (shared)"}</option>
          ))}
        </select>
        {current?.status === "error" && <p className="mb-2 text-xs text-red-500">Sign-in is failing for this mailbox. {current.ownerId ? "Reconnect it below." : "Ask an admin to reconnect it."}</p>}
        {folders.map((f) => (
          <button key={f.path} type="button" aria-current={folder === f.path ? "page" : undefined} onClick={() => goTo(box, f.path)} className={`flex items-center justify-between rounded-lg border-l-[3px] px-2.5 py-1.5 text-left text-sm ${folder === f.path ? "font-semibold" : "border-transparent"}`} style={folder === f.path ? { background: "var(--accent-soft)", color: "var(--accent)", borderLeftColor: "var(--accent)" } : undefined}>
            <span className="flex min-w-0 items-center gap-2 truncate">{f.name}{folder === f.path && loading && <span className="mail-spin" aria-label="Loading" />}</span>
            {!!f.unseen && <span className="text-xs font-semibold">{f.unseen}</span>}
          </button>
        ))}
        <div className="mt-auto space-y-1.5 border-t pt-3 text-xs" style={{ borderColor: "var(--ix-line)" }}>
          {canConnect && (
            <button type="button" className="block underline" style={muted} onClick={() => setConnecting(true)}>
              Connect another mailbox
            </button>
          )}
          {current?.ownerId && current.authType === "gmail" && (
            <a className="block underline" style={muted} href={`/api/mail/google?${new URLSearchParams({ scope: "mine", back: "/mail" })}`}>
              Reconnect with Google
            </a>
          )}
          {/* Personal mailboxes: the person can disconnect their own; shared ones are managed by admins. */}
          {current?.ownerId && (
            <button
              type="button"
              className="block text-red-600 underline"
              onClick={async () => {
                if (confirmDisconnect !== current.id) return setConfirmDisconnect(current.id);
                setConfirmDisconnect(null);
                const r = await fetch("/api/mail/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", id: current.id }) });
                if (!r.ok) return setError((await r.json().catch(() => ({}))).error ?? "Couldn't disconnect.");
                setBox(null);
                setOpen(null);
                setRows([]);
                setFolders([]);
                await loadBoxes();
              }}
            >
              {confirmDisconnect === current.id ? `Click again to disconnect ${current.email}` : `Disconnect ${current.email}`}
            </button>
          )}
        </div>
      </aside>

      {connecting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-label="Connect a mailbox">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-5 shadow-2xl" style={{ background: "var(--ix-panel)", color: "var(--ix-ink)" }}>
            <h2 className="mb-4 text-base font-semibold">Connect a mailbox</h2>
            <MailboxForm onCancel={() => setConnecting(false)} onDone={() => { setConnecting(false); void loadBoxes(); }} />
          </div>
        </div>
      )}

      {/* Message list */}
      <section className={`flex min-w-0 flex-col border-r md:w-[360px] md:flex-none ${open ? "hidden md:flex" : "flex flex-1"}`} style={{ borderColor: "var(--ix-line)" }}>
        <div className="flex items-center gap-2 border-b p-2.5" style={{ borderColor: "var(--ix-line)" }}>
          <form className="flex-1" onSubmit={(e) => { e.preventDefault(); void reload(); }}>
            <input aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail" className="w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm" />
          </form>
          <button type="button" className={btn} onClick={sync} disabled={!!busy} title="Check for new mail">
            {busy === "sync" ? "…" : "↻"}
          </button>
          {canAi && (
            <button type="button" className={btn} onClick={sortVisible} disabled={!!busy} title={`Let ${brand.shortName} label these messages`}>
              {busy === "sort" ? "Sorting…" : "Sort"}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && rows.length === 0 && (
            <div className="space-y-px" aria-busy="true" aria-label="Loading mail">
              <p className="flex items-center gap-2 px-4 pt-4 pb-2 text-sm" style={muted}><span className="mail-spin" /> Loading {folders.find((x) => x.path === folder)?.name ?? "mail"}…</p>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="mail-skel mx-3 my-2 h-12 rounded-lg" />
              ))}
            </div>
          )}
          {!loading && rows.length === 0 && <p className="p-4 text-sm" style={muted}>{q ? "No mail matches that search." : "Nothing here."}</p>}
          {rows.map((r) => (
            <button key={r.id} type="button" onClick={() => openRow(r.id)} className="block w-full border-b px-3.5 py-2.5 text-left" style={{ borderColor: "var(--ix-line)", background: open?.id === r.id ? "var(--accent-soft)" : undefined }}>
              <div className="flex items-center gap-2">
                {!r.seen && <span className="h-2 w-2 flex-none rounded-full" style={{ background: "var(--accent)" }} aria-label="Unread" />}
                <span className={`min-w-0 flex-1 truncate text-sm ${r.seen ? "" : "font-semibold"}`}>{r.fromName || r.fromAddr}</span>
                <span className="flex-none text-xs" style={muted}>{when(r.date)}</span>
              </div>
              <div className={`truncate text-sm ${r.seen ? "" : "font-medium"}`}>{r.subject}</div>
              <div className="flex items-center gap-1.5">
                {r.aiLabel && (
                  <span className="flex-none rounded-full px-1.5 text-[10.5px] font-medium text-white" style={{ background: LABEL_COLOR[r.aiLabel] ?? "#94a3b8" }}>{r.aiLabel}</span>
                )}
                {r.hasAttachments && <span className="flex-none rounded border px-1 text-[10px]" style={muted}>attachment</span>}
                <span className="truncate text-xs" style={muted}>{r.snippet}</span>
              </div>
            </button>
          ))}
          {more && (
            <button type="button" className="w-full p-3 text-sm underline" onClick={() => reload({ append: true })}>
              Older mail
            </button>
          )}
        </div>
      </section>

      {/* Reader */}
      <section className={`min-w-0 flex-1 flex-col ${open ? "flex" : "hidden md:flex"}`}>
        {error && !draft && <p className="m-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
        {!open ? (
          <div className="grid flex-1 place-items-center p-8 text-center text-sm" style={muted}>
            {busy === "open" ? "Opening…" : "Choose a message to read it."}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b p-4" style={{ borderColor: "var(--ix-line)" }}>
              <button type="button" className="mb-2 text-xs underline md:hidden" onClick={() => setOpen(null)}>← Back</button>
              <h2 className="text-lg font-semibold leading-snug">{open.subject}</h2>
              <p className="mt-1 text-sm">
                <b>{open.fromName ?? open.fromAddr}</b> <span style={muted}>&lt;{open.fromAddr}&gt; · {new Date(open.date).toLocaleString()}</span>
              </p>
              <p className="text-xs" style={muted}>To {(open.to ?? []).map((a) => a.name ?? a.address).join(", ")}{open.cc?.length ? ` · Cc ${open.cc.map((a) => a.name ?? a.address).join(", ")}` : ""}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {canSend && <button type="button" className={btn} onClick={() => reply(false)}>Reply</button>}
                {canSend && <button type="button" className={btn} onClick={() => reply(true)}>Reply all</button>}
                {canSend && (
                  <button type="button" className={btn} onClick={forward}>
                    Forward
                  </button>
                )}
                {canAi && (
                  <>
                    <button type="button" className={btn} disabled={!!busy} onClick={() => act("summarize")}>{busy === "summarize" ? "Summarizing…" : "Summarize"}</button>
                    {canSend && <button type="button" className={btn} disabled={!!busy} onClick={() => act("draft")}>{busy === "draft" ? "Drafting…" : "Draft a reply"}</button>}
                    <button type="button" className={btn} disabled={!!busy} onClick={() => act("classify")}>{busy === "classify" ? "Sorting…" : open.aiLabel ? `Label: ${open.aiLabel}` : "Label it"}</button>
                  </>
                )}
                <button type="button" className={btn} onClick={async () => { await post({ action: "unseen", id: open.id }).catch(() => undefined); setRows((c) => c.map((x) => (x.id === open.id ? { ...x, seen: false } : x))); setOpen(null); }}>
                  Mark unread
                </button>
              </div>
              {open.aiSummary && (
                <div className="mt-3 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm" style={{ background: "var(--accent-soft)" }}>
                  <b className="mb-1 block text-xs uppercase tracking-wider" style={{ color: "var(--accent)" }}>{brand.shortName} summary</b>
                  {open.aiSummary}
                </div>
              )}
              {!!open.attachments?.length && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {open.attachments.map((a) => (
                    <a key={a.part} className={btn} href={api({ view: "attachment", id: open.id, part: a.part ?? "" })}>
                      {a.filename ?? "attachment"}{a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))} KB` : ""}
                    </a>
                  ))}
                </div>
              )}
            </div>
            <iframe title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} className="min-h-0 w-full flex-1 bg-white" />
          </div>
        )}
      </section>

      {/* Compose */}
      {draft && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/30 p-4 sm:place-items-center" role="dialog" aria-label={draft.replyTo ? "Reply" : draft.forward ? "Forward" : "New message"}>
          <div className="flex h-[min(680px,92vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl" style={{ background: "var(--ix-panel)", color: "var(--ix-ink)" }}>
            <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--ix-line)", background: "var(--ix-hover)" }}>
              <b className="text-sm">{draft.replyTo ? "Reply" : draft.forward ? "Forward" : "New message"}</b>
              <button type="button" aria-label="Close" onClick={() => setDraft(null)}><Icon name="close" size={16} /></button>
            </div>
            <div className="flex-none px-4">
              <div className="flex items-center gap-2 border-b py-1.5 text-sm" style={{ borderColor: "var(--ix-line)" }}>
                <span className="w-14 flex-none" style={muted}>From</span>
                <span className="min-w-0 truncate">{current?.displayName ? `${current.displayName} <${current.email}>` : current?.email}</span>
              </div>
              <RecipientField
                label="To"
                value={draft.to}
                onChange={(to) => setDraft((d) => (d ? { ...d, to } : d))}
                contacts={contacts?.box === box ? contacts.contacts : []}
                domains={domains}
                autoFocus={!draft.to.length}
                trailing={
                  <span className="flex flex-none gap-2 pt-0.5 text-sm" style={muted}>
                    {!draft.showCc && <button type="button" className="hover:underline" onClick={() => setDraft((d) => (d ? { ...d, showCc: true } : d))}>Cc</button>}
                    {!draft.showBcc && <button type="button" className="hover:underline" onClick={() => setDraft((d) => (d ? { ...d, showBcc: true } : d))}>Bcc</button>}
                  </span>
                }
              />
              {draft.showCc && (
                <RecipientField label="Cc" value={draft.cc} onChange={(cc) => setDraft((d) => (d ? { ...d, cc } : d))} contacts={contacts?.box === box ? contacts.contacts : []} domains={domains} autoFocus={!draft.cc.length && !!draft.to.length} />
              )}
              {draft.showBcc && (
                <RecipientField label="Bcc" value={draft.bcc} onChange={(bcc) => setDraft((d) => (d ? { ...d, bcc } : d))} contacts={contacts?.box === box ? contacts.contacts : []} domains={domains} autoFocus={!draft.bcc.length && !!draft.to.length} />
              )}
              <label className="flex items-center gap-2 border-b py-1.5 text-sm" style={{ borderColor: "var(--ix-line)" }}>
                <span className="w-14 flex-none" style={muted}>Subject</span>
                <input className="min-w-0 flex-1 bg-transparent py-0.5 outline-none" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              </label>
            </div>
            <RichEditor key={draft.key} ref={editor} initialHtml={draft.html} caretAtStart placeholder="" />
            <div className="flex flex-none items-center gap-2 border-t px-4 py-2.5" style={{ borderColor: "var(--ix-line)" }}>
              <button type="button" disabled={busy === "send"} onClick={send} className="rounded-full px-5 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ background: "var(--accent)" }}>
                {busy === "send" ? "Sending…" : "Send"}
              </button>
              {error && <span className="min-w-0 flex-1 text-sm text-red-600" role="alert">{error}</span>}
              <button type="button" className="ml-auto rounded-lg border px-3 py-2 text-sm" onClick={() => setDraft(null)}>Discard</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
