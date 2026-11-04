"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";

type Followed = { instructions: string; projectMemories: string[]; memoryEnabled: boolean; personalMemories: string[]; canUndoTidy: boolean; tidiedAt: string | null };

/** Memory management: your memory across projects, and each project's memory, switch, tidy-up and undo. */
export default function MemoryPanel() {
  const [mine, setMine] = useState<string[] | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  const [f, setF] = useState<Followed | null>(null);
  const [newMine, setNewMine] = useState("");
  const [newFact, setNewFact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    fetch("/api/account/memory")
      .then((r) => r.json())
      .then((d) => setMine(d.facts ?? []))
      .catch(() => undefined);
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = (Array.isArray(d) ? d : (d?.projects ?? [])).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
        setProjects(list);
        if (list[0]) setPid(list[0].id);
      })
      .catch(() => undefined);
  }, []);
  const loadProject = useCallback(() => {
    if (!pid) return;
    fetch(`/api/projects/${pid}/memory`)
      .then((r) => r.json())
      .then(setF)
      .catch(() => undefined);
  }, [pid]);
  useEffect(loadProject, [loadProject]);
  // Company knowledge base for this project's agent.
  const [kbs, setKbs] = useState<{ mode: string; tags: string[] } | null>(null);
  const [kbTags, setKbTags] = useState("");
  useEffect(() => {
    if (!pid) return;
    fetch(`/api/projects/${pid}/kb`).then((r) => (r.ok ? r.json() : null)).then((d) => { setKbs(d); setKbTags((d?.tags ?? []).join(", ")); }).catch(() => undefined);
  }, [pid]);
  async function kbSave(mode: string, tags = kbTags) {
    setError("");
    setNote("");
    const r = await fetch(`/api/projects/${pid}/kb`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "That didn't work");
    setKbs(d);
    setNote(mode === "tags" ? "The agent checks only articles with those tags." : "The agent checks every article it may read.");
  }

  async function mineAct(body: Record<string, unknown>) {
    setError("");
    const r = await fetch("/api/account/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "That didn't work");
    setMine(d.facts);
    loadProject();
  }
  async function projAct(body: Record<string, unknown>, msg = "") {
    setError("");
    setNote("");
    setBusy(true);
    const r = await fetch(`/api/projects/${pid}/memory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "That didn't work");
    setNote(typeof d.before === "number" ? `Tidied ${d.before} memories into ${d.after}.` : msg);
    loadProject();
  }

  const row = (text: string, onDelete: () => void) => (
    <li key={text} className="flex items-start gap-2 px-4 py-2">
      <span className="flex-1">{text}</span>
      <button onClick={onDelete} aria-label={`Delete memory: ${text}`} className="text-red-500">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );

  return (
    <div className="space-y-6 text-sm">
      {(note || error) && (
        <p className={error ? "text-red-500" : "text-emerald-600"} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Your memory</h2>
        <p style={muted}>What the agent knows about you in every project, like how you like to work. It adds to this when you tell it something about yourself.</p>
        <ul className="divide-y rounded-xl border">
          {mine?.length === 0 && (
            <li className="px-4 py-3" style={muted}>
              Nothing yet.
            </li>
          )}
          {mine?.map((m) => row(m, () => void mineAct({ action: "delete", fact: m })))}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void mineAct({ action: "add", fact: newMine }).then(() => setNewMine("")); }}>
          <input value={newMine} onChange={(e) => setNewMine(e.target.value)} placeholder="e.g. I prefer short, plain-English copy" aria-label="New personal memory" className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" />
          <button className="rounded-lg border px-3 py-2">Add</button>
        </form>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Project memory</h2>
          <select value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Project" className="ml-auto rounded-lg border bg-transparent px-2 py-1 text-xs">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {f && (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.memoryEnabled} onChange={(e) => void projAct({ action: "toggle", enabled: e.target.checked }, e.target.checked ? "Memory is on for this project." : "Memory is off: the agent won't use or add memories here.")} />
              Memory on for this project
            </label>
            <ul className="divide-y rounded-xl border">
              {f.memoryEnabled && f.projectMemories.length === 0 && (
                <li className="px-4 py-3" style={muted}>
                  No memories yet. The agent saves decisions and preferences as you work.
                </li>
              )}
              {!f.memoryEnabled && (
                <li className="px-4 py-3" style={muted}>
                  Memory is off.
                </li>
              )}
              {f.projectMemories.map((m) => row(m, () => void projAct({ action: "delete", fact: m })))}
            </ul>
            {f.memoryEnabled && (
              <div className="flex flex-wrap gap-2">
                <form className="flex min-w-0 flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); void projAct({ action: "add", fact: newFact }, "Memory added.").then(() => setNewFact("")); }}>
                  <input value={newFact} onChange={(e) => setNewFact(e.target.value)} placeholder="e.g. Prices are always in euros" aria-label="New project memory" className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" />
                  <button className="rounded-lg border px-3 py-2">Add</button>
                </form>
                <button disabled={busy || f.projectMemories.length < 2} onClick={() => void projAct({ action: "tidy" })} className="rounded-lg border px-3 py-2 disabled:opacity-50" title="Merge duplicates and drop memories later ones replaced">
                  {busy ? "Tidying…" : "Tidy up"}
                </button>
                {f.canUndoTidy && (
                  <button onClick={() => void projAct({ action: "undo" }, "Tidy-up undone.")} className="rounded-lg border px-3 py-2">
                    Undo tidy-up
                  </button>
                )}
              </div>
            )}
            {kbs && (
              <div className="space-y-2 rounded-xl border px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Company knowledge</span>
                  <Link href="/knowledge" className="ml-auto text-xs underline" style={muted}>Open Knowledge</Link>
                </div>
                <p style={muted}>Every AI checks your company&apos;s knowledge base (SOPs, policies, prices) before acting on a request, and follows it. Choose which articles this project&apos;s agent uses; it can also suggest updates for a reviewer.</p>
                <div className="flex flex-wrap gap-3">
                  {([["on", "All articles"], ["tags", "Only these tags"]] as const).map(([k, l]) => (
                    <label key={k} className="flex items-center gap-1.5">
                      <input type="radio" name="kbmode" checked={kbs.mode === k} onChange={() => (k === "tags" ? setKbs({ ...kbs, mode: "tags" }) : void kbSave(k))} /> {l}
                    </label>
                  ))}
                </div>
                {kbs.mode === "tags" && (
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void kbSave("tags"); }}>
                    <input value={kbTags} onChange={(e) => setKbTags(e.target.value)} placeholder="e.g. pricing, dispatch" aria-label="Knowledge tags" className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" />
                    <button className="rounded-lg border px-3 py-2">Save</button>
                  </form>
                )}
              </div>
            )}
            <details className="rounded-xl border px-4 py-3">
              <summary className="cursor-pointer font-medium">Followed in every message</summary>
              <div className="mt-2 space-y-2 text-xs">
                <p style={muted}>Project instructions</p>
                <pre className="whitespace-pre-wrap">{f.instructions || "None."}</pre>
                <p style={muted}>Project memories ({f.projectMemories.length})</p>
                <p style={muted}>Your memories ({f.personalMemories.length})</p>
              </div>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
