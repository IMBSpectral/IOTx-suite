"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";
import type { Skill } from "@/lib/skills";

const EXAMPLES = [
  {
    name: "seo-pass",
    title: "SEO pass",
    description: "Titles, meta descriptions and social cards for every page",
    instructions:
      "Give every page a unique title under 60 characters and a meta description under 155. Add Open Graph and Twitter card tags with a sensible image. Use one h1 per page and descriptive alt text on images. Don't change the visible design.",
  },
  {
    name: "a11y-check",
    title: "Accessibility check",
    description: "Fix contrast, labels and keyboard access",
    instructions:
      "Review the app for accessibility: every input has a label, buttons and links have accessible names, colour contrast meets WCAG AA, focus is visible, and everything works with the keyboard. Fix what you find and list the fixes.",
  },
];

type Draft = Partial<Skill>;
const input = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm";

/** Workspace skills: reusable instructions run with /name in any project's chat. */
export default function SkillsPanel() {
  const [all, setAll] = useState<{ skills: Skill[]; personal: Skill[] } | null>(null);
  const [scope, setScope] = useState<"workspace" | "personal">("workspace");
  const skills = all ? (scope === "personal" ? all.personal : all.skills) : null;
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    let live = true;
    fetch("/api/workspace/skills")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setAll({ skills: d.skills ?? [], personal: d.personal ?? [] }));
    return () => {
      live = false;
    };
  }, [version]);

  async function post(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/workspace/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, ...body }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.error ?? "Something went wrong");
      return false;
    }
    setVersion((v) => v + 1);
    return true;
  }

  if (!skills) return <p className="text-sm" style={muted}>Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 text-sm" role="tablist" aria-label="Skill scope">
        {(
          [
            ["workspace", "Workspace"],
            ["personal", "Personal"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={scope === k}
            onClick={() => {
              setScope(k);
              setEditing(null);
            }}
            className={`rounded-lg px-3 py-1 ${scope === k ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
            style={scope === k ? undefined : muted}
          >
            {label}
          </button>
        ))}
      </div>
      {scope === "personal" && (
        <p className="text-sm" style={muted}>
          Personal skills teach the agent your way of working. They follow you into every project and workspace, and
          only you can use them. A workspace skill with the same name wins.
        </p>
      )}
      <p className="text-sm" style={muted}>
        Save instructions you give the agent again and again. Start a message with <code>/name</code> in any project to run one,
        optionally followed by details: <code>/seo-pass focus on the pricing page</code>. Skills apply to building turns, not
        Ask mode.
      </p>

      {editing ? (
        <form
          className="space-y-3 rounded-xl border p-4"
          style={{ background: "var(--panel)" }}
          aria-label="Edit skill"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "save", ...editing })) setEditing(null);
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-medium">
              Command
              <div className="mt-1 flex items-center rounded-lg border px-2">
                <span style={muted}>/</span>
                <input
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })}
                  placeholder="seo-pass"
                  aria-label="Command name"
                  className="w-full bg-transparent px-1 py-2 text-sm outline-none"
                />
              </div>
            </label>
            <label className="text-xs font-medium">
              Title
              <input value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className={`${input} mt-1`} placeholder="SEO pass" />
            </label>
          </div>
          <label className="block text-xs font-medium">
            Description
            <input
              value={editing.description ?? ""}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              className={`${input} mt-1`}
              placeholder="What it's for, shown in the menu"
            />
          </label>
          <label className="block text-xs font-medium">
            Instructions for the agent
            <textarea
              value={editing.instructions ?? ""}
              onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
              rows={7}
              className={`${input} mt-1 resize-y font-mono text-xs leading-relaxed`}
            />
          </label>
          {error && (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className="rounded-lg border px-3 py-1.5 text-sm">
              Cancel
            </button>
            <button className="rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ background: "var(--accent)" }}>
              Save skill
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => setEditing({})} className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm">
          <Plus className="h-4 w-4" /> New skill
        </button>
      )}

      {skills.length === 0 && !editing ? (
        <div className="rounded-xl border border-dashed p-5 text-sm">
          <p style={muted}>No skills yet. Start from an example:</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((x) => (
              <button key={x.name} onClick={() => setEditing(x)} className="rounded-full border px-3 py-1 text-xs">
                /{x.name} · {x.title}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className="divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
          {skills.map((s) => (
            <li key={s.id} className="flex items-start gap-3 p-4">
              <Wand2 className="mt-0.5 h-4 w-4 shrink-0" style={muted} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  <code>/{s.name}</code> <span className="font-normal">{s.title !== s.name ? s.title : ""}</span>
                </p>
                {s.description && (
                  <p className="text-xs" style={muted}>
                    {s.description}
                  </p>
                )}
              </div>
              <button onClick={() => setEditing(s)} className="text-xs hover:underline">
                Edit
              </button>
              <button onClick={() => post({ action: "delete", id: s.id })} aria-label={`Delete /${s.name}`} className="text-red-500">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
