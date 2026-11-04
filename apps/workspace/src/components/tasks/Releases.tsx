"use client";
import { useState } from "react";
import { Copy, Package, Plus, Rocket, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { Markdown, type Version } from "./ui";
import { Dialog } from "./Board";
import { Empty, type Ctx } from "./TasksApp";

/** Releases (versions): progress per release, release with carry-over, release notes. */
export default function Releases({ ctx }: { ctx: Ctx }) {
  const p = ctx.project!;
  const admin = p.myRole === "admin" || p.createdBy === ctx.me.id || ctx.me.owner;
  const [edit, setEdit] = useState<Partial<Version> | null>(null);
  const [releasing, setReleasing] = useState<Version | null>(null);
  const [notes, setNotes] = useState<{ v: Version; text: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = ctx.versions.filter((v) => showArchived || v.status !== "archived");

  async function save() {
    try {
      await api(`/tasks/projects/${p.id}/versions`, { body: { ...edit, startDate: edit?.startDate?.slice(0, 10) ?? null, releaseDate: edit?.releaseDate?.slice(0, 10) ?? null } });
      setEdit(null);
      ctx.reload();
    } catch (e) {
      ctx.flash((e as Error).message);
    }
  }

  return (
    <div className="tk-releases">
      <div className="tk-boardbar">
        <b>Releases</b>
        <span className="ws-muted small">Group work into versions you ship, and track how close each one is.</span>
        <span style={{ flex: 1 }} />
        <label className="tk-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        {admin && <button className="ws-btn primary" onClick={() => setEdit({ name: "", description: "" })}><Plus size={14} /> Create version</button>}
      </div>
      {list.length === 0 ? (
        <Empty icon={<Package size={26} />} title="No releases yet" body="Create a version like 1.0 or Spring launch, then set it as the Fix version on issues." action={admin ? <button className="ws-btn primary" onClick={() => setEdit({ name: "" })}><Plus size={14} /> Create version</button> : null} />
      ) : (
        <div className="tk-tablescroll">
          <table className="tk-table">
            <thead><tr><th><button>Version</button></th><th><button>Status</button></th><th><button>Progress</button></th><th><button>Start</button></th><th><button>Release date</button></th><th><button>Description</button></th><th /></tr></thead>
            <tbody>
              {list.map((v) => {
                const late = v.status === "unreleased" && v.releaseDate && new Date(v.releaseDate) < new Date();
                return (
                  <tr key={v.id} style={{ cursor: "default" }}>
                    <td><b>{v.name}</b></td>
                    <td><span className={`tk-status ${v.status === "released" ? "cat-done" : ""}`} style={{ ["--st" as string]: v.status === "released" ? "#16a34a" : v.status === "archived" ? "#94a3b8" : "#2563eb" }}>{v.status}</span></td>
                    <td style={{ minWidth: 180 }}>
                      <div className="tk-stack" title={`${v.done} done, ${v.doing} in progress, ${v.issues - v.done - v.doing} to do`}>
                        <span className="done" style={{ width: `${v.issues ? (v.done / v.issues) * 100 : 0}%` }} />
                        <span className="doing" style={{ width: `${v.issues ? (v.doing / v.issues) * 100 : 0}%` }} />
                        <span className="todo" style={{ width: `${v.issues ? ((v.issues - v.done - v.doing) / v.issues) * 100 : 0}%` }} />
                      </div>
                      <span className="ws-muted small">{v.done} of {v.issues} done</span>
                    </td>
                    <td>{v.startDate ? new Date(v.startDate).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—"}</td>
                    <td className={late ? "c-due late" : ""}>{v.releaseDate ? new Date(v.releaseDate).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—"}{late ? " · overdue" : ""}</td>
                    <td style={{ whiteSpace: "normal" }}>{v.description}</td>
                    <td>
                      <div className="ws-row" style={{ flexWrap: "nowrap" }}>
                        <button className="ws-btn" onClick={async () => { const d = await api(`/tasks/projects/${p.id}/versions?notes=${v.id}`); setNotes({ v, text: d.notes }); }}>Release notes</button>
                        {admin && v.status === "unreleased" && <button className="ws-btn primary" onClick={() => setReleasing(v)}><Rocket size={13} /> Release</button>}
                        {admin && <button className="ws-btn ghost" onClick={() => setEdit(v)}>Edit</button>}
                        {admin && v.status !== "archived" && <button className="ws-btn ghost" onClick={async () => { await api(`/tasks/projects/${p.id}/versions`, { body: { id: v.id, status: "archived" } }); ctx.reload(); }}>Archive</button>}
                        {admin && <button className="ix-iconbtn" aria-label={`Delete ${v.name}`} onClick={async () => { if (!window.confirm(`Delete ${v.name}? Its issues keep everything except the fix version.`)) return; await api(`/tasks/projects/${p.id}/versions?id=${v.id}`, { method: "DELETE" }); ctx.reload(); }}><Trash2 size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Dialog title={edit.id ? `Edit ${edit.name}` : "Create version"} onClose={() => setEdit(null)} onSubmit={() => void save()}>
          <div className="ws-field"><label className="ws-label" htmlFor="v-n">Name</label><input id="v-n" className="ws-input" autoFocus value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. 2.4 or Spring launch" /></div>
          <div className="ws-row">
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="v-s">Start date</label><input id="v-s" type="date" className="ws-input" value={edit.startDate?.slice(0, 10) ?? ""} onChange={(e) => setEdit({ ...edit, startDate: e.target.value || null })} /></div>
            <div className="ws-field" style={{ flex: 1 }}><label className="ws-label" htmlFor="v-r">Release date</label><input id="v-r" type="date" className="ws-input" value={edit.releaseDate?.slice(0, 10) ?? ""} onChange={(e) => setEdit({ ...edit, releaseDate: e.target.value || null })} /></div>
          </div>
          <div className="ws-field"><label className="ws-label" htmlFor="v-d">Description</label><textarea id="v-d" className="ws-textarea" value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
        </Dialog>
      )}
      {releasing && <ReleaseDialog ctx={ctx} v={releasing} onClose={() => setReleasing(null)} />}
      {notes && (
        <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && setNotes(null)}>
          <div className="ws-modal wide" role="dialog" aria-label="Release notes">
            <header><h3>Release notes · {notes.v.name}</h3></header>
            <div className="body"><Markdown text={notes.text} /></div>
            <footer><button className="ws-btn" onClick={() => { void navigator.clipboard?.writeText(notes.text); ctx.flash("Copied as Markdown"); }}><Copy size={13} /> Copy</button><button className="ws-btn primary" onClick={() => setNotes(null)}>Close</button></footer>
          </div>
        </div>
      )}
    </div>
  );
}

function ReleaseDialog({ ctx, v, onClose }: { ctx: Ctx; v: Version; onClose: () => void }) {
  const others = ctx.versions.filter((x) => x.status === "unreleased" && x.id !== v.id);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const open = v.issues - v.done;
  return (
    <Dialog title={`Release ${v.name}`} submit="Release" onClose={onClose} onSubmit={async () => {
      try {
        const d = await api(`/tasks/projects/${ctx.project!.id}/versions`, { body: { action: "release", id: v.id, moveTo: to || null } });
        ctx.flash(`${v.name} released${d.moved ? `; ${d.moved} unfinished issue${d.moved === 1 ? "" : "s"} moved` : ""}`);
        ctx.reload();
        onClose();
      } catch (e) {
        ctx.flash((e as Error).message);
      }
    }}>
      <p style={{ marginTop: 0 }}>{open ? <>{open} issue{open === 1 ? " is" : "s are"} not done yet.</> : "Everything in this release is done."}</p>
      {open > 0 && (
        <div className="ws-field"><label className="ws-label" htmlFor="rv-to">Move unfinished issues to</label>
          <select id="rv-to" className="ws-input" value={to} onChange={(e) => setTo(e.target.value)}>
            {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            <option value="">No version</option>
          </select>
        </div>
      )}
    </Dialog>
  );
}
