"use client";
import { useEffect, useState } from "react";
import { Folder, FolderPlus, Plus, Share2, Sparkles, Trash2, Users, X } from "lucide-react";
import { meetApi } from "../api";
import { day, useRead } from "./common";
import Ask from "./Ask";

type Rules = { titleContains?: string; attendee?: string; template?: string; topic?: string; source?: string };
type F = { id: string; name: string; kind: "personal" | "shared" | "smart"; members: string[]; rules: Rules | null; mine: boolean; count: number };
type Row = { code: string; title: string; at: string; kind: string; template: string; summary: string; topics: string[]; score: number | null; href: string };
type Person = { id: string; name: string; email: string };

const KIND_LABEL = { personal: "Personal", shared: "Shared", smart: "Smart" };
const RULES: { k: keyof Rules; label: string; ph: string }[] = [
  { k: "titleContains", label: "Title contains", ph: "Weekly sync" },
  { k: "attendee", label: "Attendee", ph: "Name or email" },
  { k: "topic", label: "Topic", ph: "Pricing" },
  { k: "template", label: "Template", ph: "sales, interview, team…" },
];

/** Folders of reports: personal, shared with members, and smart folders that fill themselves from rules. Ask inside a folder. */
export default function Folders({ people, meId }: { people: Person[]; meId: string }) {
  const { data, reload } = useRead<{ folders: F[] }>("/read/folders");
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<{ folder: F; reports: Row[] } | null>(null);
  const [tab, setTab] = useState<"reports" | "ask">("reports");
  const [form, setForm] = useState<null | { name: string; kind: F["kind"]; members: string[]; rules: Rules }>(null);
  const [adding, setAdding] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const others = people.filter((p) => p.id !== meId);

  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get("f");
    if (f) setSel(f);
  }, []);
  const loadView = (id: string) => meetApi<{ folder: F; reports: Row[] }>(`/read/folders/${id}`).then(setView).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    setView(null);
    setTab("reports");
    if (sel) loadView(sel);
  }, [sel]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setErr("");
    try {
      const r = await meetApi<{ folder: { id: string } }>("/read/folders", { body: form });
      setForm(null);
      reload();
      setSel(r.folder.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const patch = async (b: Record<string, unknown>) => {
    if (!view) return;
    setErr("");
    try {
      await meetApi(`/read/folders/${view.folder.id}`, { method: "PATCH", body: b });
      reload();
      loadView(view.folder.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const del = async () => {
    if (!view) return;
    await meetApi(`/read/folders/${view.folder.id}`, { method: "DELETE" }).catch(() => {});
    setSel(null);
    reload();
  };
  const startAdd = async () => setAdding((await meetApi<{ reports: Row[] }>("/read/reports?days=180")).reports);
  const add = async (code: string) => {
    if (!view) return;
    await meetApi(`/read/folders/${view.folder.id}/items`, { body: { codes: [code] } }).catch((e) => setErr((e as Error).message));
    loadView(view.folder.id);
    reload();
  };
  const remove = async (code: string) => {
    if (!view) return;
    await meetApi(`/read/folders/${view.folder.id}/items?code=${code}`, { method: "DELETE" }).catch((e) => setErr((e as Error).message));
    loadView(view.folder.id);
    reload();
  };
  const toggleMember = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? "Someone";

  return (
    <div className="rd-page">
      <div className="rd-head">
        <h2>Folders</h2>
        <button className="mt-btn primary" onClick={() => setForm({ name: "", kind: "personal", members: [], rules: {} })}><FolderPlus size={15} /> New folder</button>
      </div>
      {err && <p className="mt-error">{err}</p>}
      {form && (
        <form className="mt-card" onSubmit={save} style={{ display: "grid", gap: 10 }}>
          <h2>New folder</h2>
          <input className="mt-input" placeholder="Folder name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Folder name" />
          <div className="rd-seg" role="group" aria-label="Kind">
            {(["personal", "shared", "smart"] as const).map((k) => <button type="button" key={k} className={form.kind === k ? "on" : ""} onClick={() => setForm({ ...form, kind: k })}>{KIND_LABEL[k]}</button>)}
          </div>
          <p className="rd-help" style={{ margin: 0 }}>
            {form.kind === "personal" ? "Only you see it." : form.kind === "shared" ? "Members see the folder and every report in it, and can add reports." : "Reports you can open that match every rule are added (and removed) automatically. Share it to let members see them."}
          </p>
          {form.kind === "smart" && (
            <div style={{ display: "grid", gap: 8 }}>
              {RULES.map((r) => (
                <label key={r.k} className="rd-rule"><span className="mt-note">{r.label}</span><input className="mt-input" placeholder={r.ph} value={form.rules[r.k] ?? ""} onChange={(e) => setForm({ ...form, rules: { ...form.rules, [r.k]: e.target.value } })} /></label>
              ))}
              <label className="rd-rule"><span className="mt-note">Source</span>
                <select className="mt-select" value={form.rules.source ?? ""} onChange={(e) => setForm({ ...form, rules: { ...form.rules, source: e.target.value || undefined } })}>
                  <option value="">Any</option><option value="meeting">Meet call</option><option value="webinar">Webinar</option><option value="upload">Upload</option><option value="inperson">In person</option><option value="external">Zoom / Google Meet / Teams</option>
                </select>
              </label>
            </div>
          )}
          {form.kind !== "personal" && (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="mt-note">Members</legend>
              <div className="rd-tags" style={{ marginTop: 6 }}>
                {others.map((p) => <label key={p.id} className="mt-check"><input type="checkbox" checked={form.members.includes(p.id)} onChange={() => setForm({ ...form, members: toggleMember(form.members, p.id) })} /> {p.name}</label>)}
              </div>
            </fieldset>
          )}
          <div className="mt-actions"><button className="mt-btn primary">Create</button><button type="button" className="mt-btn" onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      )}
      <div className="rd-two">
        <aside className="mt-card" style={{ padding: 8 }}>
          <div className="rd-folder-list">
            {data && !data.folders.length && <p className="rd-empty">No folders yet.</p>}
            {data?.folders.map((f) => (
              <button key={f.id} className={f.id === sel ? "on" : ""} onClick={() => setSel(f.id)}>
                {f.kind === "smart" ? <Sparkles size={15} /> : f.kind === "shared" ? <Users size={15} /> : <Folder size={15} />} {f.name}
                <span className="c">{f.count}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="mt-card" style={{ minHeight: 200 }}>
          {!view && <p className="rd-empty">{sel ? "Loading…" : "Pick a folder."}</p>}
          {view && (
            <div style={{ display: "grid", gap: 12 }}>
              <div className="rd-head">
                <h2 style={{ fontSize: 17 }}>{view.folder.name}</h2>
                <span className="rd-tag">{KIND_LABEL[view.folder.kind]}</span>
                <div className="rd-seg"><button className={tab === "reports" ? "on" : ""} onClick={() => setTab("reports")}>Reports</button><button className={tab === "ask" ? "on" : ""} onClick={() => setTab("ask")}>Ask this folder</button></div>
              </div>
              {view.folder.kind === "smart" && view.folder.rules && (
                <p className="rd-help" style={{ margin: 0 }}>Rules: {Object.entries(view.folder.rules).filter(([, v]) => v).map(([k, v]) => `${RULES.find((r) => r.k === k)?.label ?? "Source"} “${v}”`).join(" · ")}</p>
              )}
              {view.folder.kind !== "personal" && (
                <p className="rd-help" style={{ margin: 0 }}>Members: {view.folder.members.length ? view.folder.members.map(name).join(", ") : "none yet"}</p>
              )}
              {view.folder.mine && (
                <div className="mt-actions">
                  {view.folder.kind === "personal" && <button className="mt-btn sm" onClick={() => patch({ kind: "shared" })}><Share2 size={13} /> Make shared</button>}
                  {view.folder.kind !== "personal" && (
                    <details>
                      <summary className="mt-btn sm" style={{ listStyle: "none" }}><Users size={13} /> Members</summary>
                      <div className="rd-tags" style={{ marginTop: 8 }}>
                        {others.map((p) => <label key={p.id} className="mt-check"><input type="checkbox" checked={view.folder.members.includes(p.id)} onChange={() => patch({ members: toggleMember(view.folder.members, p.id) })} /> {p.name}</label>)}
                      </div>
                    </details>
                  )}
                  <button className="mt-btn sm danger" onClick={del}><Trash2 size={13} /> Delete folder</button>
                </div>
              )}
              {tab === "ask" ? (
                <Ask folderId={view.folder.id} />
              ) : (
                <>
                  {view.folder.kind !== "smart" && <div><button className="mt-btn sm" onClick={startAdd}><Plus size={13} /> Add reports</button></div>}
                  {adding && (
                    <div className="mt-card" style={{ padding: 10 }}>
                      <div className="rd-head"><b style={{ flex: 1 }}>Your reports (last 180 days)</b><button className="mt-iconbtn" onClick={() => setAdding(null)} aria-label="Close"><X size={15} /></button></div>
                      <div className="mt-list" style={{ maxHeight: 260, overflowY: "auto" }}>
                        {adding.filter((r) => !view.reports.some((x) => x.code === r.code)).map((r) => (
                          <div key={r.code} className="mt-row"><span className="when">{day(r.at)}</span><span className="t">{r.title}</span><button className="mt-btn sm" onClick={() => add(r.code)}><Plus size={12} /> Add</button></div>
                        ))}
                        {!adding.length && <p className="rd-empty">No reports to add.</p>}
                      </div>
                    </div>
                  )}
                  <div className="mt-list">
                    {!view.reports.length && <p className="rd-empty">{view.folder.kind === "smart" ? "No reports match these rules yet." : "No reports in this folder yet."}</p>}
                    {view.reports.map((r) => (
                      <div key={r.code} className="rd-item">
                        <div className="body">
                          <div className="t"><a href={r.href}>{r.title}</a></div>
                          <div className="m">{day(r.at)}{r.score != null ? ` · Read score ${r.score}` : ""}{r.kind !== "meeting" ? ` · ${r.kind}` : ""}</div>
                          {r.summary && <div style={{ fontSize: 13, marginTop: 3 }}>{r.summary}</div>}
                          {!!r.topics.length && <div className="rd-tags" style={{ marginTop: 6 }}>{r.topics.map((t) => <span key={t} className="rd-tag">{t}</span>)}</div>}
                        </div>
                        {view.folder.kind !== "smart" && <button className="mt-iconbtn" aria-label="Take out of folder" onClick={() => remove(r.code)}><X size={14} /></button>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
