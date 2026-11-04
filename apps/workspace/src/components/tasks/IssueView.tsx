"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, Flag, GitBranch, Link2, MessageSquare, MoreHorizontal, Paperclip, Plus, Trash2, Upload, X } from "lucide-react";
import { FlagDialog } from "./Board";
import { api, BASE } from "@/lib/client";
import { ago, Avatar, fmtMin, labelColor, Markdown, MentionBox, Menu, PRIORITIES, PriorityIcon, StatusPill, TypeIcon, TYPES, type Task } from "./ui";
import type { Ctx } from "./TasksApp";

type Detail = {
  task: Task;
  project: { id: string; key: string; name: string; color: string; statuses: { id: string; name: string; category: string; color: string; wip: number | null }[] };
  subtasks: Task[];
  comments: { id: string; userId: string; body: string; createdAt: string; editedAt: string | null }[];
  activity: { id: string; userId: string; kind: string; field: string | null; from: string | null; to: string | null; createdAt: string }[];
  attachments: { id: string; name: string; type: string; size: number; userId: string; createdAt: string }[];
  worklogs: { id: string; userId: string; minutes: number; note: string; day: string }[];
  issueLinks: { id: string; label: string; kind: string; task: { id: string; key: string; title: string; status: string; done: boolean } }[];
  epic: { id: string; key: string; title: string } | null;
  parent: { id: string; key: string; title: string } | null;
  sprint: { id: string; name: string; state: string } | null;
  epicIssues: { id: string; key: string; title: string; done: boolean; points: number | null }[];
};
const FIELD: Record<string, string> = { title: "title", description: "description", type: "type", status: "status", priority: "priority", assigneeId: "assignee", start: "start date", due: "due date", points: "story points", estimateMin: "estimate", labels: "labels", epicId: "epic", sprintId: "sprint", projectId: "project", rule: "automation" };

/** One issue, in full: everything about it on the left, its fields on the right. */
export default function IssueView({ ctx, id, onClose, onChanged }: { ctx: Ctx; id: string; onClose: () => void; onChanged: (t: Task) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"comments" | "history" | "work">("comments");
  const [editDesc, setEditDesc] = useState(false);
  const [desc, setDesc] = useState("");
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [newSub, setNewSub] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState({ kind: "relates", other: "" });
  const [log, setLog] = useState({ time: "", note: "" });
  const [labelDraft, setLabelDraft] = useState("");
  const [dragFile, setDragFile] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [flagging, setFlagging] = useState(false);
  const { person, flash } = ctx;

  const load = useCallback(async () => {
    try {
      const x = await api<Detail>(`/tasks/${id}`);
      setD(x);
      setTitle(x.task.title);
      setDesc(x.task.description);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  if (err)
    return (
      <Shell onClose={onClose}>
        <div className="ws-empty">{err}</div>
      </Shell>
    );
  if (!d) return <Shell onClose={onClose}><div className="ws-center" style={{ minHeight: 300 }}><div className="ws-spinner" aria-hidden /></div></Shell>;

  const t = d.task;
  const p = ctx.projects.find((x) => x.id === t.projectId);
  const canWrite = !!p && p.myRole !== "viewer";
  const members = ctx.people.filter((x) => p?.memberIds.includes(x.id));
  const status = d.project.statuses.find((s) => s.id === t.status);

  async function save(body: Record<string, unknown>) {
    try {
      const r = await api<{ task: Task }>(`/tasks/${t.id}`, { method: "PATCH", body });
      onChanged(r.task);
      await load();
    } catch (e) {
      flash((e as Error).message);
      await load();
    }
  }
  async function call(path: string, body?: unknown, method?: string) {
    try {
      await api(path, { method, body });
      await load();
      return true;
    } catch (e) {
      flash((e as Error).message);
      return false;
    }
  }
  async function upload(files: FileList | File[]) {
    setUploading(true);
    for (const f of Array.from(files)) {
      const form = new FormData();
      form.append("file", f);
      const r = await fetch(`${BASE}/api/tasks/${t.id}/attachments`, { method: "POST", body: form });
      if (!r.ok) flash((await r.json().catch(() => ({}))).error ?? `Couldn't attach ${f.name}`);
    }
    setUploading(false);
    await load();
  }
  const copyLink = () => {
    void navigator.clipboard?.writeText(`${location.origin}/workspace/tasks?project=${t.projectId}&task=${t.key}`);
    flash("Link copied");
  };

  const logged = d.worklogs.reduce((a, w) => a + w.minutes, 0);
  const remaining = t.estimateMin != null ? Math.max(0, t.estimateMin - logged) : null;

  return (
    <Shell onClose={onClose} onDrop={(f) => canWrite && void upload(f)} dragging={dragFile} setDragging={setDragFile}>
      <header className="tk-iv-head">
        <nav className="tk-crumbs" aria-label="Breadcrumb">
          <span className="tk-proj-ico sm" style={{ background: d.project.color }}>{d.project.key.slice(0, 2)}</span>
          <span>{d.project.name}</span>
          {d.epic && <><span>/</span><button className="tk-linkbtn" onClick={() => ctx.open(d.epic!.id)}><TypeIcon type="epic" size={13} /> {d.epic.key}</button></>}
          {d.parent && <><span>/</span><button className="tk-linkbtn" onClick={() => ctx.open(d.parent!.id)}>{d.parent.key}</button></>}
          <span>/</span>
          <TypeIcon type={t.type} size={14} />
          <b>{t.key}</b>
        </nav>
        <span style={{ flex: 1 }} />
        <button className="ix-iconbtn" onClick={() => void call(`/tasks/${t.id}/watch`, { on: !t.watchers.includes(ctx.me.id) })} title={t.watchers.includes(ctx.me.id) ? "Stop watching" : "Watch"} aria-label={t.watchers.includes(ctx.me.id) ? "Stop watching" : "Watch"}>
          {t.watchers.includes(ctx.me.id) ? <Eye size={17} /> : <EyeOff size={17} />}
          <span className="tk-iv-count">{t.watchers.length}</span>
        </button>
        <button className="ix-iconbtn" onClick={copyLink} title="Copy link" aria-label="Copy link"><Copy size={16} /></button>
        <Menu label="More actions" align="right" button={() => <button className="ix-iconbtn" aria-label="More actions"><MoreHorizontal size={17} /></button>}>
          {(close) => (
            <div className="tk-proj-menu">
              {canWrite && ctx.me.perms["tasks.create"] && <button className="tk-mi" onClick={async () => { close(); try { const r = await api(`/tasks/${t.id}/clone`, { body: {} }); flash(`Cloned as ${r.task.key}`); ctx.reload(); ctx.open(r.task.id); } catch (e) { flash((e as Error).message); } }}>Clone</button>}
              {canWrite && !t.parentId && ctx.projects.filter((x) => x.id !== t.projectId && x.myRole !== "viewer").length > 0 && (
                <>
                  <div className="tk-mi-sect">Move to project</div>
                  {ctx.projects.filter((x) => x.id !== t.projectId && x.myRole !== "viewer").map((x) => <button key={x.id} className="tk-mi" onClick={() => { close(); void save({ projectId: x.id }); }}>{x.name}</button>)}
                </>
              )}
              {canWrite && ctx.me.perms["tasks.delete"] && <button className="tk-mi danger" onClick={async () => { close(); if (!window.confirm(`Delete ${t.key}${d.subtasks.length ? ` and its ${d.subtasks.length} subtasks` : ""}? This can't be undone.`)) return; await api(`/tasks/${t.id}`, { method: "DELETE" }).catch((e) => flash(e.message)); flash(`${t.key} deleted`); onClose(); }}><Trash2 size={14} /> Delete</button>}
            </div>
          )}
        </Menu>
        <button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>

      <div className="tk-iv">
        <main className="tk-iv-main">
          {canWrite ? (
            <textarea className="tk-iv-title" value={title} rows={1} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && void save({ title })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} aria-label="Summary" />
          ) : <h2 className="tk-iv-title">{t.title}</h2>}

          {t.flagged && (
            <div className="tk-flagbar" role="status"><Flag size={14} /> <b>Flagged</b>{t.flagNote ? `: ${t.flagNote}` : ""}{canWrite && <button className="tk-linkbtn small" onClick={() => void save({ flagged: false })}>Remove flag</button>}</div>
          )}
          <div className="tk-iv-actions">
            {canWrite && <button className="ws-btn" onClick={() => fileRef.current?.click()}><Paperclip size={14} /> Attach</button>}
            {canWrite && !t.parentId && t.type !== "epic" && <button className="ws-btn" onClick={() => document.getElementById("tk-newsub")?.focus()}><GitBranch size={14} /> Add subtask</button>}
            {canWrite && <button className="ws-btn" onClick={() => setLinkOpen(true)}><Link2 size={14} /> Link issue</button>}
            {canWrite && !t.flagged && <button className="ws-btn" onClick={() => setFlagging(true)}><Flag size={14} /> Add flag</button>}
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
          </div>

          <section className="tk-iv-sect">
            <h4>Description</h4>
            {editDesc ? (
              <div>
                <MentionBox value={desc} onChange={setDesc} people={members} rows={8} autoFocus placeholder="Add a description. Markdown works: **bold**, _italic_, `code`, lists, - [ ] checkboxes, links." onSubmit={() => { void save({ description: desc }); setEditDesc(false); }} />
                <div className="ws-row" style={{ marginTop: 8 }}>
                  <button className="ws-btn primary" onClick={() => { void save({ description: desc }); setEditDesc(false); }}>Save</button>
                  <button className="ws-btn ghost" onClick={() => { setDesc(t.description); setEditDesc(false); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className={`tk-iv-desc${canWrite ? " editable" : ""}`} onClick={() => canWrite && setEditDesc(true)} role={canWrite ? "button" : undefined} tabIndex={canWrite ? 0 : undefined} onKeyDown={(e) => e.key === "Enter" && canWrite && setEditDesc(true)}>
                <Markdown text={t.description} empty={<span className="ws-muted">{canWrite ? "Add a description…" : "No description."}</span>} />
              </div>
            )}
          </section>

          {t.type === "epic" && (
            <section className="tk-iv-sect">
              <h4>Issues in this epic <span className="ws-muted">{d.epicIssues.filter((x) => x.done).length} of {d.epicIssues.length} done</span></h4>
              <Progress done={d.epicIssues.filter((x) => x.done).length} total={d.epicIssues.length} />
              <ul className="tk-iv-rows">
                {d.epicIssues.map((x) => <li key={x.id}><button className="tk-linkbtn" onClick={() => ctx.open(x.id)}><span className={`tk-key${x.done ? " done" : ""}`}>{x.key}</span> {x.title}</button>{x.points != null && <span className="tk-points light">{x.points}</span>}</li>)}
              </ul>
              {canWrite && <button className="tk-addbtn" onClick={() => ctx.create({ epicId: t.id, projectId: t.projectId })}><Plus size={14} /> Add an issue to this epic</button>}
            </section>
          )}

          {!t.parentId && t.type !== "epic" && (
            <section className="tk-iv-sect">
              <h4>Subtasks {d.subtasks.length > 0 && <span className="ws-muted">{d.subtasks.filter((s) => s.done).length} of {d.subtasks.length} done</span>}</h4>
              {d.subtasks.length > 0 && <Progress done={d.subtasks.filter((s) => s.done).length} total={d.subtasks.length} />}
              <ul className="tk-iv-rows">
                {d.subtasks.map((s) => (
                  <li key={s.id}>
                    <TypeIcon type="subtask" size={14} />
                    <button className="tk-linkbtn grow" onClick={() => ctx.open(s.id)}><span className={`tk-key${s.done ? " done" : ""}`}>{s.key}</span> {s.title}</button>
                    <Avatar person={person(s.assigneeId)} size={20} />
                    {canWrite ? (
                      <select className="tk-mini-select" value={s.status} onChange={(e) => void call(`/tasks/${s.id}`, { status: e.target.value }, "PATCH")} aria-label={`Status of ${s.key}`}>
                        {d.project.statuses.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                      </select>
                    ) : <StatusPill s={d.project.statuses.find((x) => x.id === s.status) as never} />}
                  </li>
                ))}
              </ul>
              {canWrite && (
                <form className="tk-iv-inline" onSubmit={async (e) => { e.preventDefault(); if (newSub.trim() && (await call("/tasks", { projectId: t.projectId, parentId: t.id, title: newSub.trim() }))) setNewSub(""); }}>
                  <input id="tk-newsub" className="ws-input" placeholder="Add a subtask and press Enter" value={newSub} onChange={(e) => setNewSub(e.target.value)} />
                </form>
              )}
            </section>
          )}

          {(d.issueLinks.length > 0 || linkOpen) && (
            <section className="tk-iv-sect">
              <h4>Linked issues</h4>
              {Object.entries(groupBy(d.issueLinks, (l) => l.label)).map(([label, ls]) => (
                <div key={label} className="tk-iv-linkgroup">
                  <div className="ws-muted">{label}</div>
                  <ul className="tk-iv-rows">
                    {ls.map((l) => (
                      <li key={l.id}>
                        <button className="tk-linkbtn grow" onClick={() => ctx.open(l.task.id)}><span className={`tk-key${l.task.done ? " done" : ""}`}>{l.task.key}</span> {l.task.title}</button>
                        <span className="tk-status">{l.task.status}</span>
                        {canWrite && <button className="ix-iconbtn" style={{ width: 24, height: 24 }} aria-label="Remove link" onClick={() => void call(`/tasks/links/${l.id}`, undefined, "DELETE")}><X size={13} /></button>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {linkOpen && (
                <form className="tk-iv-inline row" onSubmit={async (e) => { e.preventDefault(); if (await call(`/tasks/${t.id}/links`, link)) { setLink({ kind: "relates", other: "" }); setLinkOpen(false); } }}>
                  <select className="ws-input" style={{ width: "auto" }} value={link.kind} onChange={(e) => setLink({ ...link, kind: e.target.value })} aria-label="Link type">
                    <option value="blocks">blocks</option><option value="relates">relates to</option><option value="duplicates">duplicates</option><option value="clones">clones</option>
                  </select>
                  <input className="ws-input" autoFocus placeholder={`Issue key, e.g. ${d.project.key}-1`} value={link.other} onChange={(e) => setLink({ ...link, other: e.target.value })} />
                  <button className="ws-btn primary">Link</button>
                  <button type="button" className="ws-btn ghost" onClick={() => setLinkOpen(false)}>Cancel</button>
                </form>
              )}
            </section>
          )}

          {(d.attachments.length > 0 || uploading) && (
            <section className="tk-iv-sect">
              <h4>Attachments <span className="ws-muted">{d.attachments.length}</span></h4>
              <div className="tk-files">
                {d.attachments.map((a) => (
                  <div key={a.id} className="tk-file">
                    <a href={`${BASE}/api/tasks/attachments/${a.id}`} target="_blank" rel="noreferrer" className="thumb">
                      {/^image\/(png|jpeg|gif|webp)$/.test(a.type) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`${BASE}/api/tasks/attachments/${a.id}`} alt={a.name} />
                      ) : <span className="ext">{a.name.split(".").pop()?.slice(0, 4).toUpperCase()}</span>}
                    </a>
                    <div className="meta">
                      <a href={`${BASE}/api/tasks/attachments/${a.id}?download=1`} className="nm" title={a.name}>{a.name}</a>
                      <span className="ws-muted">{(a.size / 1024).toFixed(a.size > 102400 ? 0 : 1)} KB · {ago(a.createdAt)}</span>
                    </div>
                    {canWrite && <button className="ix-iconbtn" style={{ width: 24, height: 24 }} aria-label={`Remove ${a.name}`} onClick={() => window.confirm(`Remove ${a.name}?`) && void call(`/tasks/attachments/${a.id}`, undefined, "DELETE")}><Trash2 size={13} /></button>}
                  </div>
                ))}
                {uploading && <div className="tk-file"><div className="ws-spinner" aria-hidden /> Uploading…</div>}
              </div>
            </section>
          )}

          <section className="tk-iv-sect">
            <div className="ws-seg" role="tablist" aria-label="Activity">
              <button role="tab" aria-pressed={tab === "comments"} onClick={() => setTab("comments")}><MessageSquare size={13} /> Comments {d.comments.length > 0 && d.comments.length}</button>
              <button role="tab" aria-pressed={tab === "history"} onClick={() => setTab("history")}>History</button>
              <button role="tab" aria-pressed={tab === "work"} onClick={() => setTab("work")}>Work log {logged > 0 && fmtMin(logged)}</button>
            </div>
            {tab === "comments" && (
              <div className="tk-comments">
                <div className="tk-comment new">
                  <Avatar person={person(ctx.me.id)} size={30} />
                  <div className="grow">
                    <MentionBox value={comment} onChange={setComment} people={members} rows={2} placeholder="Add a comment… (@ to mention, Ctrl+Enter to send)" onSubmit={async () => { if (comment.trim() && (await call(`/tasks/${t.id}/comments`, { body: comment }))) setComment(""); }} />
                    {comment.trim() && <div className="ws-row" style={{ marginTop: 6 }}><button className="ws-btn primary" onClick={async () => { if (await call(`/tasks/${t.id}/comments`, { body: comment })) setComment(""); }}>Save</button><button className="ws-btn ghost" onClick={() => setComment("")}>Cancel</button></div>}
                  </div>
                </div>
                {[...d.comments].reverse().map((c) => (
                  <div key={c.id} className="tk-comment">
                    <Avatar person={person(c.userId)} size={30} />
                    <div className="grow">
                      <div className="hd"><b>{person(c.userId)?.name ?? "Someone"}</b> <span className="ws-muted">{ago(c.createdAt)}{c.editedAt ? " · edited" : ""}</span></div>
                      {editing?.id === c.id ? (
                        <>
                          <MentionBox value={editing.body} onChange={(b) => setEditing({ id: c.id, body: b })} people={members} rows={3} autoFocus onSubmit={async () => { if (await call(`/tasks/comments/${c.id}`, { body: editing.body }, "PATCH")) setEditing(null); }} />
                          <div className="ws-row" style={{ marginTop: 6 }}><button className="ws-btn primary" onClick={async () => { if (await call(`/tasks/comments/${c.id}`, { body: editing.body }, "PATCH")) setEditing(null); }}>Save</button><button className="ws-btn ghost" onClick={() => setEditing(null)}>Cancel</button></div>
                        </>
                      ) : (
                        <>
                          <Markdown text={c.body} />
                          {(c.userId === ctx.me.id || ctx.me.owner) && (
                            <div className="tk-comment-act">
                              {c.userId === ctx.me.id && <button onClick={() => setEditing({ id: c.id, body: c.body })}>Edit</button>}
                              <button onClick={() => window.confirm("Delete this comment?") && void call(`/tasks/comments/${c.id}`, undefined, "DELETE")}>Delete</button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {tab === "history" && (
              <ul className="tk-history">
                {d.activity.map((a) => (
                  <li key={a.id}>
                    <Avatar person={person(a.userId)} size={22} />
                    <span>
                      <b>{person(a.userId)?.name ?? "Someone"}</b>{" "}
                      {a.kind === "created" ? "created the issue" : a.kind === "comment" ? "commented" : a.kind === "attachment" ? <>attached <i>{a.to}</i></> : a.kind === "link" ? <>linked: <i>{a.to}</i></> : a.kind === "worklog" ? <>logged {a.to}</> : a.field === "rule" ? <>ran the rule <i>{a.to}</i></> : (
                        <>changed the {a.field?.startsWith("custom:") ? a.field.slice(7) : (FIELD[a.field ?? ""] ?? a.field)}{a.field !== "description" && <>: <s className="ws-muted">{a.from || "none"}</s> → <b>{a.to || "none"}</b></>}</>
                      )}
                      <span className="ws-muted"> · {ago(a.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {tab === "work" && (
              <div>
                {canWrite && (
                  <form className="tk-iv-inline row" onSubmit={async (e) => { e.preventDefault(); if (await call(`/tasks/${t.id}/worklogs`, log)) setLog({ time: "", note: "" }); }}>
                    <input className="ws-input" style={{ width: 130 }} placeholder="e.g. 1h 30m" value={log.time} onChange={(e) => setLog({ ...log, time: e.target.value })} aria-label="Time spent" />
                    <input className="ws-input" placeholder="What did you work on? (optional)" value={log.note} onChange={(e) => setLog({ ...log, note: e.target.value })} aria-label="Note" />
                    <button className="ws-btn primary" disabled={!log.time.trim()}>Log time</button>
                  </form>
                )}
                <ul className="tk-history">
                  {d.worklogs.length === 0 && <li className="ws-muted">No time logged yet.</li>}
                  {d.worklogs.map((w) => (
                    <li key={w.id}>
                      <Avatar person={person(w.userId)} size={22} />
                      <span className="grow"><b>{person(w.userId)?.name}</b> logged <b>{fmtMin(w.minutes)}</b> on {new Date(w.day).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" })}{w.note && <> · {w.note}</>}</span>
                      {(w.userId === ctx.me.id || ctx.me.owner) && <button className="ix-iconbtn" style={{ width: 24, height: 24 }} aria-label="Remove" onClick={() => void call(`/tasks/worklogs/${w.id}`, undefined, "DELETE")}><X size={13} /></button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </main>

        <aside className="tk-iv-side">
          {canWrite ? (
            <select className={`tk-statusbtn cat-${status?.category}`} style={{ ["--st" as string]: status?.color }} value={t.status} onChange={(e) => void save({ status: e.target.value })} aria-label="Status">
              {d.project.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : <StatusPill s={status as never} />}

          <dl className="tk-fields">
            <Field label="Assignee">
              {canWrite ? (
                <div className="tk-who">
                  <Avatar person={person(t.assigneeId)} size={22} />
                  <select className="tk-fieldsel" value={t.assigneeId ?? ""} onChange={(e) => void save({ assigneeId: e.target.value || null })} aria-label="Assignee">
                    <option value="">Unassigned</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              ) : <span className="tk-who"><Avatar person={person(t.assigneeId)} size={22} /> {person(t.assigneeId)?.name ?? "Unassigned"}</span>}
              {canWrite && t.assigneeId !== ctx.me.id && members.some((m) => m.id === ctx.me.id) && <button className="tk-linkbtn small" onClick={() => void save({ assigneeId: ctx.me.id })}>Assign to me</button>}
            </Field>
            <Field label="Reporter"><span className="tk-who"><Avatar person={person(t.createdBy)} size={22} /> {person(t.createdBy)?.name ?? "Someone"}</span></Field>
            <Field label="Type">
              {canWrite && !t.parentId ? (
                <div className="tk-who"><TypeIcon type={t.type} /><select className="tk-fieldsel" value={t.type} onChange={(e) => void save({ type: e.target.value })} aria-label="Type">{TYPES.filter((x) => x.id !== "subtask").map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></div>
              ) : <span className="tk-who"><TypeIcon type={t.type} /> {TYPES.find((x) => x.id === t.type)?.label}</span>}
            </Field>
            <Field label="Priority">
              <div className="tk-who"><PriorityIcon p={t.priority} />{canWrite ? <select className="tk-fieldsel" value={t.priority} onChange={(e) => void save({ priority: Number(e.target.value) })} aria-label="Priority">{PRIORITIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select> : PRIORITIES[t.priority]?.label}</div>
            </Field>
            <Field label="Labels">
              <div className="tk-labels">
                {t.labels.map((l) => (
                  <span key={l} className="tk-lbl" style={{ ["--lc" as string]: labelColor(l, p?.labelDefs ?? []) }}>
                    {l}
                    {canWrite && <button aria-label={`Remove ${l}`} onClick={() => void save({ labels: t.labels.filter((x) => x !== l) })}><X size={11} /></button>}
                  </span>
                ))}
                {canWrite && (
                  <form onSubmit={(e) => { e.preventDefault(); const v = labelDraft.trim(); if (v && !t.labels.includes(v)) void save({ labels: [...t.labels, v] }); setLabelDraft(""); }}>
                    <input className="tk-labelin" list="tk-label-options" value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} placeholder="+ Label" aria-label="Add a label" />
                    <datalist id="tk-label-options">{(p?.labelDefs ?? []).map((l) => <option key={l.name} value={l.name} />)}</datalist>
                  </form>
                )}
              </div>
            </Field>
            {!t.parentId && t.type !== "epic" && (
              <Field label="Epic">
                {canWrite ? (
                  <select className="tk-fieldsel" value={t.epicId ?? ""} onChange={(e) => void save({ epicId: e.target.value || null })} aria-label="Epic">
                    <option value="">None</option>
                    {ctx.epics.filter((e) => e.projectId === t.projectId).map((e) => <option key={e.id} value={e.id}>{e.key} {e.title}</option>)}
                  </select>
                ) : (d.epic?.title ?? "None")}
              </Field>
            )}
            {!t.parentId && (
              <Field label="Sprint">
                {canWrite ? (
                  <select className="tk-fieldsel" value={t.sprintId ?? ""} onChange={(e) => void save({ sprintId: e.target.value || null })} aria-label="Sprint">
                    <option value="">Backlog</option>
                    {ctx.sprints.filter((s) => s.projectId === t.projectId && (s.state !== "closed" || s.id === t.sprintId)).map((s) => <option key={s.id} value={s.id} disabled={s.state === "closed"}>{s.name}{s.state === "active" ? " (active)" : ""}</option>)}
                  </select>
                ) : (d.sprint?.name ?? "Backlog")}
              </Field>
            )}
            {p?.features.releases !== false && ctx.versions.length > 0 && (
              <Field label="Fix version">
                {canWrite ? (
                  <select className="tk-fieldsel" value={t.versionId ?? ""} onChange={(e) => void save({ versionId: e.target.value || null })} aria-label="Fix version">
                    <option value="">None</option>
                    {ctx.versions.filter((v) => v.status !== "archived" || v.id === t.versionId).map((v) => <option key={v.id} value={v.id}>{v.name}{v.status === "released" ? " (released)" : ""}</option>)}
                  </select>
                ) : (ctx.versions.find((v) => v.id === t.versionId)?.name ?? "None")}
              </Field>
            )}
            {p?.features.components !== false && ctx.components.length > 0 && (
              <Field label="Components">
                <div className="tk-labels">
                  {t.componentIds.map((cid) => (
                    <span key={cid} className="tk-lbl" style={{ ["--lc" as string]: "#0891b2" }}>
                      {ctx.components.find((c) => c.id === cid)?.name ?? "?"}
                      {canWrite && <button aria-label="Remove component" onClick={() => void save({ componentIds: t.componentIds.filter((x) => x !== cid) })}><X size={11} /></button>}
                    </span>
                  ))}
                  {canWrite && ctx.components.some((c) => !t.componentIds.includes(c.id)) && (
                    <select className="tk-labelin" value="" onChange={(e) => e.target.value && void save({ componentIds: [...t.componentIds, e.target.value] })} aria-label="Add a component">
                      <option value="">+ Add</option>
                      {ctx.components.filter((c) => !t.componentIds.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                </div>
              </Field>
            )}
            <Field label="Story points">
              {canWrite ? <input className="tk-fieldsel" type="number" min={0} step={0.5} defaultValue={t.points ?? ""} key={`pts${t.points}`} onBlur={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v !== t.points) void save({ points: v }); }} aria-label="Story points" placeholder="None" /> : (t.points ?? "None")}
            </Field>
            <Field label="Start date">
              {canWrite ? <input className="tk-fieldsel" type="date" value={t.start ?? ""} onChange={(e) => void save({ start: e.target.value || null })} aria-label="Start date" /> : (t.start ?? "None")}
            </Field>
            <Field label="Due date">
              {canWrite ? <input className={`tk-fieldsel${t.overdue ? " late" : ""}`} type="date" value={t.due ?? ""} onChange={(e) => void save({ due: e.target.value || null })} aria-label="Due date" /> : (t.due ?? "None")}
            </Field>
            {(p?.fieldDefs ?? []).map((f) => (
              <Field key={f.id} label={f.name}>
                <CustomField f={f} value={t.custom?.[f.id]} canWrite={canWrite} members={members} onSave={(v) => void save({ custom: { [f.id]: v } })} />
              </Field>
            ))}
            <Field label="Time tracking">
              <div className="tk-timebar" title={`${fmtMin(logged)} logged${t.estimateMin != null ? ` of ${fmtMin(t.estimateMin)} estimated` : ""}`}>
                <span style={{ width: `${t.estimateMin ? Math.min(100, (logged / t.estimateMin) * 100) : logged ? 100 : 0}%` }} className={t.estimateMin != null && logged > t.estimateMin ? "over" : ""} />
              </div>
              <div className="ws-muted small">{fmtMin(logged)} logged{remaining != null ? ` · ${fmtMin(remaining)} remaining` : ""}</div>
              {canWrite && (
                <label className="small tk-est">Estimate <input className="tk-fieldsel" defaultValue={t.estimateMin != null ? fmtMin(t.estimateMin) : ""} key={`est${t.estimateMin}`} placeholder="e.g. 4h" onBlur={(e) => { const m = parseDur(e.target.value); if (e.target.value.trim() === "" ? t.estimateMin !== null : m !== null && m !== t.estimateMin) void save({ estimateMin: e.target.value.trim() === "" ? null : m }); }} /></label>
              )}
            </Field>
          </dl>
          <div className="tk-iv-dates ws-muted">
            <div>Created {new Date(t.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div>
            <div>Updated {ago(t.updatedAt)}</div>
            {!t.done && <div>In {status?.name ?? "this status"} for {Math.max(0, Math.floor((Date.now() - new Date(t.statusAt).getTime()) / 86_400_000))} day(s)</div>}
            {t.completedAt && <div>Resolved {new Date(t.completedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div>}
            {t.messageId && <div><a className="ws-link" href={`/workspace/chat?message=${t.messageId}`}>Made from a chat message</a></div>}
          </div>
          {canWrite && <button className="ws-btn tk-attach-side" onClick={() => fileRef.current?.click()}><Upload size={14} /> Drop files here or click to attach</button>}
        </aside>
      </div>
      {flagging && <FlagDialog t={t} onClose={() => setFlagging(false)} onSave={(note) => { setFlagging(false); void save({ flagged: true, flagNote: note || null }); }} />}
    </Shell>
  );
}

function CustomField({ f, value, canWrite, members, onSave }: { f: import("./ui").FieldDef; value: string | number | boolean | undefined; canWrite: boolean; members: { id: string; name: string }[]; onSave: (v: string | number | boolean | null) => void }) {
  if (!canWrite) {
    if (value === undefined || value === "") return <span className="ws-muted">None</span>;
    if (f.type === "user") return <>{members.find((m) => m.id === value)?.name ?? "Someone"}</>;
    if (f.type === "checkbox") return <>{value ? "Yes" : "No"}</>;
    return <>{String(value)}</>;
  }
  if (f.type === "checkbox") return <input type="checkbox" checked={value === true} onChange={(e) => onSave(e.target.checked)} aria-label={f.name} />;
  if (f.type === "select")
    return (
      <select className="tk-fieldsel" value={value === undefined ? "" : String(value)} onChange={(e) => onSave(e.target.value || null)} aria-label={f.name}>
        <option value="">None</option>
        {f.options?.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  if (f.type === "user")
    return (
      <select className="tk-fieldsel" value={value === undefined ? "" : String(value)} onChange={(e) => onSave(e.target.value || null)} aria-label={f.name}>
        <option value="">None</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    );
  if (f.type === "date") return <input className="tk-fieldsel" type="date" value={value === undefined ? "" : String(value)} onChange={(e) => onSave(e.target.value || null)} aria-label={f.name} />;
  return (
    <input
      className="tk-fieldsel"
      type={f.type === "number" ? "number" : "text"}
      defaultValue={value === undefined ? "" : String(value)}
      key={String(value)}
      placeholder="None"
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (value === undefined ? "" : String(value))) onSave(v === "" ? null : f.type === "number" ? Number(v) : v); }}
      aria-label={f.name}
    />
  );
}

function parseDur(s: string): number | null {
  const v = s.trim().toLowerCase();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  let total = 0;
  let ok = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m)/g)) {
    ok = true;
    total += Number(m[1]) * { w: 2400, d: 480, h: 60, m: 1 }[m[2] as "w"];
  }
  return ok ? Math.round(total) : null;
}

function groupBy<T>(xs: T[], k: (x: T) => string) {
  return xs.reduce<Record<string, T[]>>((a, x) => ({ ...a, [k(x)]: [...(a[k(x)] ?? []), x] }), {});
}

function Progress({ done, total }: { done: number; total: number }) {
  return <div className="tk-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Shell({ children, onClose, onDrop, dragging, setDragging }: { children: React.ReactNode; onClose: () => void; onDrop?: (f: FileList) => void; dragging?: boolean; setDragging?: (b: boolean) => void }) {
  return (
    <div className="ws-modal-scrim tk-iv-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`ws-modal tk-iv-modal${dragging ? " dropping" : ""}`}
        role="dialog"
        aria-label="Issue"
        onDragOver={(e) => { if (onDrop && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging?.(true); } }}
        onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragging?.(false); }}
        onDrop={(e) => { if (onDrop && e.dataTransfer.files.length) { e.preventDefault(); setDragging?.(false); onDrop(e.dataTransfer.files); } }}
      >
        {children}
      </div>
    </div>
  );
}
