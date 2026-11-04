"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Bookmark, CalendarDays, CalendarRange, ChevronDown, Download, Filter, KanbanSquare, Keyboard, Layers, LayoutDashboard, ListTree, Package, Plus, Rows3, Search, Settings, Star, X, Zap } from "lucide-react";
import type { Boot } from "@/lib/page";
import { api, subscribe } from "@/lib/client";
import { Avatar, Menu, PRIORITIES, TYPES, type Component, type Project, type Sprint, type Task, type Version } from "./ui";
import Summary from "./Summary";
import TaskCalendar from "./TaskCalendar";
import Releases from "./Releases";
import Board from "./Board";
import Backlog from "./Backlog";
import Table from "./Table";
import Timeline from "./Timeline";
import Reports from "./Reports";
import IssueView from "./IssueView";
import CreateIssue from "./CreateIssue";
import ProjectSettings from "./ProjectSettings";

export type View = "summary" | "board" | "backlog" | "list" | "timeline" | "calendar" | "releases" | "reports";
export type Filters = { text: string; assignees: string[]; types: string[]; priorities: number[]; labels: string[]; epic: string; onlyMine: boolean; recent: boolean };
const NO_FILTERS: Filters = { text: "", assignees: [], types: [], priorities: [], labels: [], epic: "", onlyMine: false, recent: false };

const VIEWS: { id: View; label: string; Icon: typeof KanbanSquare; key: string }[] = [
  { id: "summary", label: "Summary", Icon: LayoutDashboard, key: "1" },
  { id: "board", label: "Board", Icon: KanbanSquare, key: "2" },
  { id: "backlog", label: "Backlog", Icon: Rows3, key: "3" },
  { id: "list", label: "List", Icon: ListTree, key: "4" },
  { id: "timeline", label: "Timeline", Icon: CalendarRange, key: "5" },
  { id: "calendar", label: "Calendar", Icon: CalendarDays, key: "6" },
  { id: "releases", label: "Releases", Icon: Package, key: "7" },
  { id: "reports", label: "Reports", Icon: BarChart3, key: "8" },
];

export type Ctx = {
  me: Boot["me"];
  people: Boot["people"];
  project: Project | null;
  projects: Project[];
  sprints: Sprint[];
  epics: Task[];
  versions: Version[];
  components: Component[];
  person: (id: string | null) => Boot["people"][number] | undefined;
  open: (id: string) => void;
  create: (preset?: Partial<Task>) => void;
  patch: (id: string, body: Record<string, unknown>) => Promise<Task | null>;
  reload: () => void;
  flash: (m: string) => void;
  canWrite: boolean;
};

export default function TasksApp({ boot }: { boot: Boot }) {
  const { me, people } = boot;
  const [projects, setProjects] = useState<Project[]>([]);
  const [sel, setSel] = useState<string>("mine");
  const [view, setView] = useState<View>("board");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [epics, setEpics] = useState<Task[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  // Quick filters made by the project's admins: issue ids each one matches.
  const [qf, setQf] = useState<Record<string, Set<string>>>({});
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [saved, setSaved] = useState<{ id: string; name: string; query: Partial<Filters> & { projectId?: string }; shared: boolean; userId: string }[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<Partial<Task> | null>(null);
  const [settings, setSettings] = useState<Project | "new" | null>(null);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [help, setHelp] = useState(false);
  // The address is only rewritten once the first load has read it.
  const [booted, setBooted] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(""), 3800);
  }, []);
  const person = useCallback((id: string | null) => people.find((p) => p.id === id), [people]);
  const project = projects.find((p) => p.id === sel) ?? null;
  const canWrite = !project || project.myRole !== "viewer";

  // ── Loading
  const loadProjects = useCallback(async () => {
    const d = await api<{ projects: Project[] }>("/tasks/projects");
    setProjects(d.projects);
    return d.projects;
  }, []);
  const loadTasks = useCallback(async () => {
    const q = new URLSearchParams();
    if (sel === "mine") q.set("mine", "1");
    else q.set("projectId", sel);
    const [t, s, e, v, c] = await Promise.all([
      api<{ tasks: Task[] }>(`/tasks?${q}`),
      sel === "mine" ? Promise.resolve({ sprints: [] as Sprint[] }) : api<{ sprints: Sprint[] }>(`/tasks/projects/${sel}/sprints`),
      sel === "mine" ? Promise.resolve({ tasks: [] as Task[] }) : api<{ tasks: Task[] }>(`/tasks?projectId=${sel}&type=epic`),
      sel === "mine" ? Promise.resolve({ versions: [] as Version[] }) : api<{ versions: Version[] }>(`/tasks/projects/${sel}/versions`),
      sel === "mine" ? Promise.resolve({ components: [] as Component[] }) : api<{ components: Component[] }>(`/tasks/projects/${sel}/components`),
    ]);
    setTasks(t.tasks);
    setSprints(s.sprints);
    setEpics(e.tasks);
    setVersions(v.versions);
    setComponents(c.components);
    setLoading(false);
  }, [sel]);
  const reload = useCallback(() => {
    void loadTasks().catch((e) => flash(e.message));
    void loadProjects().catch(() => {});
  }, [loadTasks, loadProjects, flash]);

  // First load: the project and issue in the address, or the last project used.
  useEffect(() => {
    const u = new URL(window.location.href);
    void loadProjects().then((ps) => {
      let want = u.searchParams.get("project");
      try {
        want ??= localStorage.getItem("tk-project");
      } catch {}
      if (want && (want === "mine" || ps.some((p) => p.id === want))) setSel(want);
      else if (ps[0]) setSel(ps[0].id);
      const v = u.searchParams.get("view") as View | null;
      if (v && VIEWS.some((x) => x.id === v)) setView(v);
      const t = u.searchParams.get("task");
      if (t) setOpenId(t);
      setBooted(true);
    });
    void api("/tasks/filters").then((d) => setSaved(d.filters)).catch(() => {});
  }, [loadProjects]);
  useEffect(() => {
    setLoading(true);
    setTasks([]);
    void loadTasks().catch((e) => flash(e.message));
    try {
      localStorage.setItem("tk-project", sel);
    } catch {}
  }, [sel, loadTasks, flash]);
  // Keep the address shareable: project, view and the open issue.
  useEffect(() => {
    if (!booted) return;
    const u = new URL(window.location.href);
    u.searchParams.set("project", sel);
    u.searchParams.set("view", view);
    const key = openId ? (tasks.find((t) => t.id === openId)?.key ?? openId) : null;
    if (key) u.searchParams.set("task", key);
    else u.searchParams.delete("task");
    window.history.replaceState(null, "", u.toString());
  }, [sel, view, openId, tasks, booted]);

  // Live: someone else changed an issue here.
  useEffect(() => {
    let t: number | undefined;
    return subscribe((type, d) => {
      if (type !== "task") return;
      if (sel !== "mine" && d?.projectId !== sel) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => void loadTasks().catch(() => {}), 350);
    });
  }, [sel, loadTasks]);

  // Keyboard: c new issue, / search, 1-5 views, ? help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return;
      if (document.querySelector(".ws-modal-scrim")) return;
      if (e.key === "c" && canWrite) { e.preventDefault(); setCreating({}); }
      else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "?") { e.preventDefault(); setHelp(true); }
      else {
        const v = VIEWS.find((x) => x.key === e.key);
        if (v && (sel !== "mine" || v.id === "board" || v.id === "list" || v.id === "calendar")) setView(v.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, canWrite]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      // Show the change at once; put it back if the server says no.
      const before = tasks;
      setTasks((ts) => ts.map((t) => (t.id === id ? ({ ...t, ...body } as Task) : t)));
      try {
        const d = await api<{ task: Task }>(`/tasks/${id}`, { method: "PATCH", body });
        setTasks((ts) => ts.map((t) => (t.id === id ? d.task : t)));
        return d.task;
      } catch (e) {
        setTasks(before);
        flash((e as Error).message);
        return null;
      }
    },
    [tasks, flash],
  );

  // ── Filters (applied in the browser over the loaded issues)
  const labels = useMemo(() => [...new Set(tasks.flatMap((t) => t.labels))].sort(), [tasks]);
  const shown = useMemo(() => {
    const f = filters;
    const text = f.text.trim().toLowerCase();
    const week = Date.now() - 7 * 86_400_000;
    return tasks.filter(
      (t) =>
        (!text || t.title.toLowerCase().includes(text) || t.key.toLowerCase() === text || t.key.toLowerCase().includes(text) || t.description.toLowerCase().includes(text)) &&
        (!f.assignees.length || f.assignees.includes(t.assigneeId ?? "none")) &&
        (!f.types.length || f.types.includes(t.type)) &&
        (!f.priorities.length || f.priorities.includes(t.priority)) &&
        (!f.labels.length || f.labels.some((l) => t.labels.includes(l))) &&
        (!f.epic || (f.epic === "none" ? !t.epicId : t.epicId === f.epic)) &&
        (!f.onlyMine || t.assigneeId === me.id) &&
        Object.values(qf).every((ids) => ids.has(t.id)) &&
        (!f.recent || new Date(t.updatedAt).getTime() > week),
    );
  }, [tasks, filters, me.id, qf]);
  async function toggleQuick(id: string, query: string) {
    if (qf[id]) {
      const n = { ...qf };
      delete n[id];
      return setQf(n);
    }
    try {
      const d = await api<{ tasks: Task[] }>(`/tasks?q=${encodeURIComponent(query)}`);
      setQf({ ...qf, [id]: new Set(d.tasks.map((t) => t.id)) });
    } catch (e) {
      flash(`Quick filter: ${(e as Error).message}`);
    }
  }
  useEffect(() => setQf({}), [sel]);
  const active = Object.keys(qf).length > 0 || filters.text || filters.assignees.length || filters.types.length || filters.priorities.length || filters.labels.length || filters.epic || filters.onlyMine || filters.recent;
  const toggle = <K extends "assignees" | "types" | "priorities" | "labels">(k: K, v: Filters[K][number]) =>
    setFilters((f) => ({ ...f, [k]: (f[k] as unknown[]).includes(v) ? (f[k] as unknown[]).filter((x) => x !== v) : [...(f[k] as unknown[]), v] }));
  const members = project ? people.filter((p) => project.memberIds.includes(p.id)) : people.filter((p) => tasks.some((t) => t.assigneeId === p.id));

  const [naming, setNaming] = useState<string | null>(null);
  async function saveFilter(name: string) {
    if (!name.trim()) return;
    try {
      const d = await api("/tasks/filters", { body: { name, query: { ...filters, ...(sel !== "mine" ? { projectId: sel } : {}) }, shared: false } });
      setSaved((s) => [...s, d.filter]);
      flash(`Saved "${name}"`);
      setNaming(null);
    } catch (e) {
      flash((e as Error).message);
    }
  }

  const ctx: Ctx = { me, people, project, projects, sprints, epics, versions, components, person, open: setOpenId, create: (p) => setCreating(p ?? {}), patch, reload, flash, canWrite };
  const views = sel === "mine"
    ? VIEWS.filter((v) => v.id === "board" || v.id === "list" || v.id === "calendar")
    : VIEWS.filter((v) => (v.id !== "releases" || project?.features.releases !== false) && (v.id !== "backlog" || project?.features.sprints !== false));
  const v = views.some((x) => x.id === view) ? view : "board";

  // Until the first load has read the address, show nothing that could flash the wrong project.
  if (!booted) return <div className="ws-app tk-app"><div className="ws-center" style={{ flex: 1 }}><div className="ws-spinner" aria-hidden /></div></div>;

  return (
    <div className="ws-app tk-app">
      {/* Project bar */}
      <div className="tk-head">
        <Menu
          label="Switch project"
          button={() => (
            <button className="tk-proj-btn">
              {project ? <span className="tk-proj-ico" style={{ background: project.color }}>{project.key.slice(0, 2)}</span> : <span className="tk-proj-ico mine"><Star size={13} /></span>}
              <span className="tk-proj-name">
                <b>{project ? project.name : "My work"}</b>
                <small>{project ? `${project.key} · ${project.open} open${project.activeSprint ? ` · ${project.activeSprint.name}` : ""}` : "Assigned to me across projects"}</small>
              </span>
              <ChevronDown size={15} />
            </button>
          )}
        >
          {(close) => (
            <div className="tk-proj-menu">
              <button className={`tk-mi${sel === "mine" ? " on" : ""}`} onClick={() => { setSel("mine"); close(); }}>
                <span className="tk-proj-ico mine sm"><Star size={11} /></span> My work
              </button>
              <div className="tk-mi-sect">Projects</div>
              {projects.map((p) => (
                <button key={p.id} className={`tk-mi${sel === p.id ? " on" : ""}`} onClick={() => { setSel(p.id); setFilters(NO_FILTERS); close(); }}>
                  <span className="tk-proj-ico sm" style={{ background: p.color }}>{p.key.slice(0, 2)}</span>
                  <span className="grow">{p.name}</span>
                  <span className="ws-muted">{p.key}</span>
                </button>
              ))}
              {me.perms["tasks.project.create"] && (
                <button className="tk-mi accent" onClick={() => { setSettings("new"); close(); }}>
                  <Plus size={14} /> New project
                </button>
              )}
            </div>
          )}
        </Menu>
        <nav className="tk-tabs" aria-label="Views">
          {views.map((x) => (
            <button key={x.id} aria-pressed={v === x.id} onClick={() => setView(x.id)} title={`${x.label} (${x.key})`}>
              <x.Icon size={15} /> <span>{x.label}</span>
            </button>
          ))}
        </nav>
        <span style={{ flex: 1 }} />
        <a className="ix-iconbtn" href={`/workspace/api/tasks/export?${sel === "mine" ? "mine=1" : `projectId=${sel}`}`} title="Export to CSV" aria-label="Export to CSV"><Download size={16} /></a>
        <button className="ix-iconbtn" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><Keyboard size={16} /></button>
        {project && (project.myRole === "admin" || project.createdBy === me.id || me.owner) && (
          <button className="ix-iconbtn" onClick={() => setSettings(project)} title="Project settings" aria-label="Project settings"><Settings size={16} /></button>
        )}
        {canWrite && me.perms["tasks.create"] && (project || projects.length > 0) && (
          <button className="ws-btn primary" onClick={() => setCreating({})} title="Create an issue (c)">
            <Plus size={15} /> Create
          </button>
        )}
      </div>

      {/* Filter bar */}
      {v !== "reports" && v !== "summary" && v !== "releases" && (
        <div className="tk-filters">
          <label className="tk-search">
            <Search size={14} />
            <input ref={searchRef} value={filters.text} onChange={(e) => setFilters({ ...filters, text: e.target.value })} placeholder="Search this board" aria-label="Search issues" />
          </label>
          {sel !== "mine" && <div className="tk-avs" role="group" aria-label="Filter by assignee">
            {members.slice(0, 8).map((p) => (
              <button key={p.id} className={filters.assignees.includes(p.id) ? "on" : ""} onClick={() => toggle("assignees", p.id)} aria-pressed={filters.assignees.includes(p.id)} title={p.name}>
                <Avatar person={p} size={26} />
              </button>
            ))}
            <button className={filters.assignees.includes("none") ? "on" : ""} onClick={() => toggle("assignees", "none")} aria-pressed={filters.assignees.includes("none")} title="Unassigned">
              <Avatar size={26} />
            </button>
          </div>}
          {sel !== "mine" && <button className={`ws-btn${filters.onlyMine ? " on" : ""}`} onClick={() => setFilters({ ...filters, onlyMine: !filters.onlyMine })}>Only my issues</button>}
          <button className={`ws-btn${filters.recent ? " on" : ""}`} onClick={() => setFilters({ ...filters, recent: !filters.recent })}>Recently updated</button>
          <Menu label="More filters" button={() => <button className={`ws-btn${filters.types.length || filters.priorities.length || filters.labels.length || filters.epic ? " on" : ""}`}><Filter size={14} /> Filters</button>}>
            {() => (
              <div className="tk-filter-pop">
                <div className="tk-mi-sect">Type</div>
                <div className="tk-chiprow">{TYPES.filter((t) => t.id !== "subtask").map((t) => <button key={t.id} className={`ws-chip${filters.types.includes(t.id) ? " on" : ""}`} onClick={() => toggle("types", t.id)}>{t.label}</button>)}</div>
                <div className="tk-mi-sect">Priority</div>
                <div className="tk-chiprow">{PRIORITIES.map((p) => <button key={p.id} className={`ws-chip${filters.priorities.includes(p.id) ? " on" : ""}`} onClick={() => toggle("priorities", p.id)}>{p.label}</button>)}</div>
                {labels.length > 0 && (
                  <>
                    <div className="tk-mi-sect">Label</div>
                    <div className="tk-chiprow">{labels.map((l) => <button key={l} className={`ws-chip${filters.labels.includes(l) ? " on" : ""}`} onClick={() => toggle("labels", l)}>{l}</button>)}</div>
                  </>
                )}
                {epics.length > 0 && (
                  <>
                    <div className="tk-mi-sect">Epic</div>
                    <select className="ws-input" value={filters.epic} onChange={(e) => setFilters({ ...filters, epic: e.target.value })} aria-label="Epic">
                      <option value="">Any epic</option>
                      <option value="none">No epic</option>
                      {epics.map((e) => <option key={e.id} value={e.id}>{e.key} {e.title}</option>)}
                    </select>
                  </>
                )}
              </div>
            )}
          </Menu>
          <Menu label="Saved filters" align="right" button={() => <button className="ws-btn"><Bookmark size={14} /> Saved</button>}>
            {(close) => (
              <div className="tk-proj-menu">
                {saved.length === 0 && <div className="tk-mi ws-muted">No saved filters yet.</div>}
                {saved.map((s) => (
                  <div key={s.id} className="tk-mi">
                    <button className="grow tk-linkbtn" onClick={() => { setFilters({ ...NO_FILTERS, ...s.query }); if (s.query.projectId && projects.some((p) => p.id === s.query.projectId)) setSel(s.query.projectId); close(); }}>
                      {s.name} {s.shared && <span className="ws-muted">· shared</span>}
                    </button>
                    {s.userId === me.id && (
                      <button className="ix-iconbtn" style={{ width: 24, height: 24 }} aria-label={`Delete ${s.name}`} onClick={async () => { await api(`/tasks/filters?id=${s.id}`, { method: "DELETE" }); setSaved((x) => x.filter((y) => y.id !== s.id)); }}>
                        <X size={13} />
                      </button>
                    )}
                  </div>
                ))}
                {active ? (naming === null ? <button className="tk-mi accent" onClick={() => setNaming("")}><Plus size={14} /> Save current filter</button> : (
                  <form className="tk-mi" onSubmit={(e) => { e.preventDefault(); void saveFilter(naming).then(close); }}>
                    <input className="ws-input" autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Name this filter" aria-label="Filter name" />
                    <button className="ws-btn primary" disabled={!naming.trim()}>Save</button>
                  </form>
                )) : null}
              </div>
            )}
          </Menu>
          {project?.quickFilters.map((q) => (
            <button key={q.id} className={`ws-btn${qf[q.id] ? " on" : ""}`} onClick={() => void toggleQuick(q.id, q.query)} title={q.query}><Zap size={13} /> {q.name}</button>
          ))}
          {active ? <button className="ws-btn ghost" onClick={() => { setFilters(NO_FILTERS); setQf({}); }}>Clear filters</button> : null}
        </div>
      )}

      {/* The view */}
      <div className="tk-body">
        {loading ? (
          <div className="ws-center" style={{ flex: 1 }}><div className="ws-spinner" aria-hidden /></div>
        ) : projects.length === 0 && sel !== "mine" ? (
          <Empty title="Start your first project" body="Projects hold your issues, board, backlog and sprints. Give it a name and a short key like WEB, and invite your team." action={me.perms["tasks.project.create"] ? <button className="ws-btn primary" onClick={() => setSettings("new")}><Plus size={15} /> New project</button> : null} />
        ) : v === "board" ? (
          <Board ctx={ctx} tasks={shown} all={tasks} mine={sel === "mine"} />
        ) : v === "backlog" && project ? (
          <Backlog ctx={ctx} tasks={shown} />
        ) : v === "list" ? (
          <Table ctx={ctx} tasks={shown} mine={sel === "mine"} />
        ) : v === "timeline" && project ? (
          <Timeline ctx={ctx} tasks={shown} />
        ) : v === "summary" && project ? (
          <Summary ctx={ctx} />
        ) : v === "calendar" ? (
          <TaskCalendar ctx={ctx} tasks={shown} />
        ) : v === "releases" && project ? (
          <Releases ctx={ctx} />
        ) : v === "reports" && project ? (
          <Reports ctx={ctx} />
        ) : null}
      </div>

      {openId && <IssueView ctx={ctx} id={openId} onClose={() => { setOpenId(null); reload(); }} onChanged={(t) => setTasks((ts) => ts.map((x) => (x.id === t.id ? t : x)))} />}
      {creating && (
        <CreateIssue
          ctx={ctx}
          preset={creating}
          defaultProject={project?.id ?? projects[0]?.id}
          onClose={() => setCreating(null)}
          onCreated={(t, again) => {
            setTasks((ts) => (ts.some((x) => x.id === t.id) || (sel !== "mine" && t.projectId !== sel) ? ts : [...ts, t]));
            flash(`${t.key} created`);
            if (!again) setCreating(null);
            reload();
          }}
        />
      )}
      {settings && (
        <ProjectSettings
          ctx={ctx}
          project={settings === "new" ? null : settings}
          onClose={() => setSettings(null)}
          onSaved={(p, created) => {
            void loadProjects();
            if (created) setSel(p.id);
            setSettings(null);
            reload();
          }}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {toast && <div className="ws-toast" role="status">{toast}</div>}
    </div>
  );
}

export function Empty({ title, body, action, icon }: { title: string; body: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="tk-empty">
      <div className="tk-empty-art" aria-hidden>{icon ?? <Layers size={26} />}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows = [["c", "Create an issue"], ["/", "Search"], ["1 – 8", "Summary, Board, Backlog, List, Timeline, Calendar, Releases, Reports"], ["e / v", "Epic or version panel in the Backlog"], ["?", "This help"], ["Esc", "Close a dialog"], ["Ctrl + Enter", "Send a comment or save"], ["j / k", "Next / previous issue in the list"], ["Enter", "Open the focused issue"]];
  return (
    <div className="ws-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ws-modal" role="dialog" aria-label="Keyboard shortcuts">
        <header><h3>Keyboard shortcuts</h3><button className="ix-iconbtn" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <div className="body">
          <table className="tk-keys"><tbody>{rows.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
        </div>
      </div>
    </div>
  );
}
