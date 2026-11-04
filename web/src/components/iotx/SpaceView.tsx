"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "./icons";
import { openInSuite } from "./tabs";
import { spacesChanged } from "./browser/SpacesNav";

type Item = {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  status: "ok" | "unpublished" | "no_access";
  emoji?: string | null;
  description?: string | null;
  editor?: string;
};
type Space = {
  id: string;
  kind: "dashboard" | "folder";
  name: string;
  mine: boolean;
  canAdd: boolean;
  canShare: boolean;
  children: { id: string; kind: "dashboard" | "folder"; name: string }[];
  items: Item[];
};

async function post(body: Record<string, unknown>) {
  const r = await fetch("/api/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Couldn't save that.");
  return d;
}

/**
 * One dashboard or folder. A dashboard shows its apps as modules (tabs across
 * the top, the app below, running on its own subdomain with its own access
 * rules); a folder shows what is kept in it. Who sees this page is set in
 * Admin → Roles and with Share.
 */
export default function SpaceView({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [s, setS] = useState<Space | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "add" | "share">(null);
  const [manage, setManage] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/spaces?id=${encodeURIComponent(id)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "Couldn't open this.");
    setS(d);
    setName(d.name);
    document.title = d.name;
  }, [id]);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener("iotx:spaces", on);
    return () => window.removeEventListener("iotx:spaces", on);
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  async function act(body: Record<string, unknown>, msg?: string) {
    try {
      const d = await post(body);
      if (msg) setToast(msg);
      spacesChanged();
      await load();
      return d;
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Couldn't save that.");
      return null;
    }
  }

  const selected = useMemo(() => {
    if (!s) return null;
    const want = params.get("item");
    if (want) return s.items.find((i) => i.id === want) ?? null;
    return s.kind === "dashboard" ? (s.items[0] ?? null) : null;
  }, [s, params]);
  const select = (itemId: string | null) => router.replace(itemId ? `/spaces/${id}?item=${itemId}` : `/spaces/${id}`);

  if (error)
    return (
      <div className="ix-space-page">
        <div className="ix-card" style={{ margin: 24 }}>
          <b>Not available</b>
          <p className="ix-hint">{error}</p>
        </div>
      </div>
    );
  if (!s) return <div style={{ padding: 24, color: "var(--ix-muted)" }}>Loading…</div>;

  const dash = s.kind === "dashboard";
  // An open app fills the whole page; the dashboard's header comes back with "Manage".
  const focus = !!selected && !manage && !panel;
  return (
    <div className={`ix-space-page ${focus ? "focus" : ""}`}>
      <header className="ix-space-head" hidden={focus}>
        <span className="ix-space-ico">
          <Icon name={dash ? "dashboard" : "folder"} size={18} />
        </span>
        {s.mine ? (
          <input
            className="ix-space-title"
            value={name}
            maxLength={80}
            aria-label="Name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== s.name && void act({ action: "rename", id, name }, "Renamed.")}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h1 className="ix-space-title">{s.name}</h1>
        )}
        <span className="ix-chip muted">{dash ? "Dashboard" : "Folder"}</span>
        <span style={{ flex: 1 }} />
        {manage && selected && (
          <button className="ix-btn primary" onClick={() => (setManage(false), setPanel(null))}>
            Back to {selected.title}
          </button>
        )}
        {s.canAdd && (
          <button className="ix-btn" onClick={() => setPanel(panel === "add" ? null : "add")} aria-expanded={panel === "add"}>
            <Icon name="add" size={14} /> {dash ? "Add app" : "Add"}
          </button>
        )}
        {s.canShare && (
          <button className="ix-btn" onClick={() => setPanel(panel === "share" ? null : "share")} aria-expanded={panel === "share"}>
            <Icon name="people" size={14} /> Who can see
          </button>
        )}
        {s.mine &&
          (confirmDelete ? (
            <>
              <button
                className="ix-btn danger"
                onClick={async () => {
                  if (await act({ action: "delete", id }, `${s.name} deleted.`)) openInSuite("/home");
                }}
              >
                Delete {dash ? "dashboard" : "folder"}
              </button>
              <button className="ix-btn" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="ix-iconbtn" title="Delete" aria-label="Delete" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={16} />
            </button>
          ))}
      </header>

      {panel === "add" && <AddPanel space={s} act={act} onDone={() => setPanel(null)} />}
      {panel === "share" && <SharePanel id={id} onChange={() => spacesChanged()} />}

      {dash && s.items.length > 1 && !focus && (
        <div className="ix-space-tabs" role="tablist" aria-label="Modules">
          {s.items.map((i) => (
            <button key={i.id} role="tab" aria-selected={selected?.id === i.id} className={selected?.id === i.id ? "on" : ""} onClick={() => select(i.id)}>
              {i.emoji ? <span>{i.emoji}</span> : <Icon name="builder" size={13} />}
              {i.title}
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <Module
          item={selected}
          canRemove={s.mine}
          onRemove={() => act({ action: "removeItem", itemId: selected.id }, `${selected.title} removed.`).then(() => select(null))}
          onBack={dash ? undefined : () => select(null)}
          space={focus ? { name: s.name, items: s.items, onPick: select, onManage: () => setManage(true) } : undefined}
        />
      ) : dash ? (
        <div className="ix-space-empty-state">
          <Icon name="dashboard" size={34} />
          <b>No apps in this dashboard yet</b>
          <p className="ix-hint">Move apps you built in the Builder here. Each keeps its own access rules; this dashboard&apos;s access is set in Admin → Roles.</p>
          {s.canAdd && (
            <button className="ix-btn primary" onClick={() => setPanel("add")}>
              <Icon name="add" size={14} /> Add app
            </button>
          )}
        </div>
      ) : (
        <FolderGrid space={s} onOpenItem={(i) => (i.kind === "link" ? openInSuite(i.url ?? "/home") : select(i.id))} act={act} />
      )}

      {toast && (
        <div className="ix-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function Module({
  item,
  canRemove,
  onRemove,
  onBack,
  space,
}: {
  item: Item;
  canRemove: boolean;
  onRemove: () => void;
  onBack?: () => void;
  /** Full-page mode: the dashboard's name, its other apps and the way back to its settings. */
  space?: { name: string; items: Item[]; onPick: (id: string) => void; onManage: () => void };
}) {
  return (
    <div className="ix-space-module">
      <div className="ix-space-modbar">
        {onBack && (
          <button className="ix-iconbtn" onClick={onBack} aria-label="Back to folder" title="Back to folder">
            <Icon name="back" size={15} />
          </button>
        )}
        {space && <span className="ix-space-crumb">{space.name} ›</span>}
        {space && space.items.length > 1 ? (
          <select className="ix-space-switch" value={item.id} onChange={(e) => space.onPick(e.target.value)} aria-label="App in this dashboard">
            {space.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        ) : (
          <b>{item.title}</b>
        )}
        <span style={{ flex: 1 }} />
        {item.url && (
          <a className="ix-btn" href={item.url} target="_blank" rel="noopener noreferrer">
            <Icon name="globe" size={14} /> Open on its own
          </a>
        )}
        {item.editor && (
          <button className="ix-btn" onClick={() => openInSuite(item.editor!, { newTab: true })}>
            <Icon name="builder" size={14} /> Edit in Builder
          </button>
        )}
        {space && (
          <button className="ix-btn" onClick={space.onManage} title="Add apps, change who can see it">
            <Icon name="settings" size={14} /> Manage
          </button>
        )}
        {canRemove && (
          <button className="ix-iconbtn" onClick={onRemove} aria-label={`Remove ${item.title}`} title="Remove from here (the app itself stays)">
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
      {item.status === "ok" && item.url ? (
        <iframe className="ix-space-frame" src={item.url} title={item.title} allow="clipboard-write; fullscreen" />
      ) : (
        <div className="ix-space-empty-state">
          <Icon name={item.status === "no_access" ? "lock" : "builder"} size={30} />
          <b>{item.status === "no_access" ? "You don't have access to this app" : "This app isn't published yet"}</b>
          <p className="ix-hint">
            {item.status === "no_access"
              ? "Ask the app's owner or an admin to invite you."
              : "Publish it from the Builder and it appears here, on its own subdomain."}
          </p>
        </div>
      )}
    </div>
  );
}

function FolderGrid({ space, onOpenItem, act }: { space: Space; onOpenItem: (i: Item) => void; act: (b: Record<string, unknown>, m?: string) => Promise<unknown> }) {
  if (!space.children.length && !space.items.length)
    return (
      <div className="ix-space-empty-state">
        <Icon name="folder" size={34} />
        <b>This folder is empty</b>
        <p className="ix-hint">Add apps, links to pages, dashboards or other folders for quick access.</p>
      </div>
    );
  return (
    <div className="ix-space-grid">
      {space.children.map((c) => (
        <button key={c.id} className="ix-space-card" onClick={() => openInSuite(`/spaces/${c.id}`)}>
          <Icon name={c.kind === "dashboard" ? "dashboard" : "folder"} size={22} />
          <b>{c.name}</b>
          <span className="ix-hint">{c.kind === "dashboard" ? "Dashboard" : "Folder"}</span>
        </button>
      ))}
      {space.items.map((i) => (
        <div key={i.id} className="ix-space-card">
          <button className="ix-space-cardbtn" onClick={() => onOpenItem(i)}>
            {i.emoji ? <span style={{ fontSize: 22 }}>{i.emoji}</span> : <Icon name={i.kind === "link" ? "link" : "builder"} size={22} />}
            <b>{i.title}</b>
            <span className="ix-hint">{i.kind === "link" ? i.url : i.status === "ok" ? "App" : i.status === "unpublished" ? "App · not published" : "No access"}</span>
          </button>
          {space.mine && (
            <button className="ix-iconbtn ix-space-x" aria-label={`Remove ${i.title}`} title="Remove from folder" onClick={() => void act({ action: "removeItem", itemId: i.id }, `${i.title} removed.`)}>
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function AddPanel({ space, act, onDone }: { space: Space; act: (b: Record<string, unknown>, m?: string) => Promise<unknown>; onDone: () => void }) {
  const [apps, setApps] = useState<{ id: string; name: string; emoji: string | null; published: boolean }[] | null>(null);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"app" | "link" | "folder" | "dashboard">("app");
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  useEffect(() => {
    fetch("/api/spaces?apps=1")
      .then((r) => r.json())
      .then((d) => setApps(d.apps ?? []))
      .catch(() => setApps([]));
  }, []);
  const have = new Set(space.items.filter((i) => i.kind === "project").map((i) => i.editor?.split("/").pop()));
  const shown = (apps ?? []).filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()));
  const dash = space.kind === "dashboard";
  return (
    <div className="ix-card ix-space-panel">
      {!dash && (
        <div className="ix-tabs" role="tablist" style={{ marginBottom: 10 }}>
          {(
            [
              ["app", "App"],
              ["link", "Link to a page"],
              ["folder", "Folder"],
              ["dashboard", "Dashboard"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {mode === "app" && (
        <>
          <input className="ix-input" placeholder="Search your apps" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search apps" autoFocus />
          <div className="ix-space-picks">
            {apps === null && <div className="ix-hint">Loading apps…</div>}
            {apps && !shown.length && <div className="ix-hint">No apps found. Build one in the Builder first.</div>}
            {shown.map((a) => (
              <button
                key={a.id}
                className="ix-menuitem"
                disabled={have.has(a.id)}
                onClick={() => void act({ action: "addItem", spaceId: space.id, kind: "project", ref: a.id }, `${a.name} added.`)}
              >
                <span>{a.emoji ?? "▣"}</span> {a.name}
                <span className="ix-hint" style={{ marginLeft: "auto" }}>
                  {have.has(a.id) ? "Added" : a.published ? "Published" : "Not published"}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {mode === "link" && (
        <form
          className="ix-space-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ action: "addItem", spaceId: space.id, kind: "link", ref: link, title }, "Link added.")) {
              setLink("");
              setTitle("");
            }
          }}
        >
          <input className="ix-input" placeholder="/sheets/… or https://…" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Address" autoFocus />
          <input className="ix-input" placeholder="Name (optional)" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Name" />
          <button className="ix-btn primary" disabled={!link.trim()}>
            Add link
          </button>
        </form>
      )}
      {(mode === "folder" || mode === "dashboard") && (
        <form
          className="ix-space-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ action: "create", kind: mode, name: title, parentId: space.id }, `${mode === "folder" ? "Folder" : "Dashboard"} created.`)) setTitle("");
          }}
        >
          <input className="ix-input" placeholder={mode === "folder" ? "Folder name" : "Dashboard name"} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Name" autoFocus />
          <button className="ix-btn primary" disabled={!title.trim()}>
            Create {mode}
          </button>
        </form>
      )}
      <div style={{ textAlign: "right", marginTop: 8 }}>
        <button className="ix-btn" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function SharePanel({ id, onChange }: { id: string; onChange: () => void }) {
  const [d, setD] = useState<{ roles: { id: string; name: string; builtin: string | null; on: boolean }[]; people: { id: string; name: string | null; email: string; on: boolean }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(async () => {
    const r = await fetch(`/api/spaces?access=${encodeURIComponent(id)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(j.error ?? "Couldn't load access.");
    setD(j);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const set = async (subjectType: "role" | "user", subjectId: string, on: boolean) => {
    try {
      await post({ action: "setAccess", id, subjectType, subjectId, on });
      onChange();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save that.");
    }
  };
  if (err) return <div className="ix-card ix-space-panel ix-error">{err}</div>;
  if (!d) return <div className="ix-card ix-space-panel ix-hint">Loading…</div>;
  const people = d.people.filter((p) => !q || `${p.name ?? ""} ${p.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="ix-card ix-space-panel">
      <p className="ix-hint" style={{ marginTop: 0 }}>
        Owners and people who manage dashboards and folders always see it. Roles can also be ticked in Admin → Roles. The apps inside keep their own access.
      </p>
      <div className="ix-space-share">
        <div>
          <h5>Roles</h5>
          {d.roles.map((r) => (
            <label key={r.id} className="ix-space-check">
              <input type="checkbox" checked={r.on} onChange={(e) => void set("role", r.id, e.target.checked)} />
              {r.name}
            </label>
          ))}
        </div>
        <div>
          <h5>People</h5>
          <input className="ix-input" placeholder="Find people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find people" />
          <div className="ix-space-picks">
            {people.map((p) => (
              <label key={p.id} className="ix-space-check">
                <input type="checkbox" checked={p.on} onChange={(e) => void set("user", p.id, e.target.checked)} />
                {p.name ?? p.email} <span className="ix-hint">{p.name ? p.email : ""}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
