"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, X } from "lucide-react";

type Feature = { id: string; label: string; tried: boolean; prompt: string | null; href: string | null };
type Project = { id: string; name: string };
const KEY = "forge-features-checklist-hidden";

const HINTS: Record<string, string> = {
  plan: "In any project, pick Plan in the mode menu next to Send.",
  publish: "Open a project and press Publish.",
};

/** Welcome-back checklist: what you've tried, and a nudge to try the rest on one of your projects. */
export default function FeatureChecklist() {
  const router = useRouter();
  const [data, setData] = useState<{ features: Feature[]; lastProject: Project | null } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [trying, setTrying] = useState<Feature | null>(null);
  const [target, setTarget] = useState("");
  const [hidden, setHidden] = useState(true);
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(KEY) === "1");
    } catch {
      setHidden(false);
    }
    fetch("/api/account/features")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setData(d);
        setTarget(d.lastProject?.id ?? "");
      })
      .catch(() => undefined);
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setProjects((Array.isArray(d) ? d : (d.projects ?? [])).slice(0, 30).map((p: Project) => ({ id: p.id, name: p.name }))))
      .catch(() => undefined);
  }, []);

  if (!data || hidden) return null;
  const tried = data.features.filter((f) => f.tried).length;
  if (tried === data.features.length) return null;

  return (
    <section className="relative z-10 mx-auto mb-6 max-w-[672px] rounded-xl border px-4 py-3 text-xs" style={{ background: "var(--panel)" }} aria-label="Features tried">
      <div className="flex items-center gap-2">
        <span className="font-medium">Features tried</span>
        <span style={muted}>
          {tried} of {data.features.length}
        </span>
        {data.lastProject && (
          <Link href={`/projects/${data.lastProject.id}`} className="ml-auto underline">
            Continue {data.lastProject.name}
          </Link>
        )}
        <button
          onClick={() => {
            try {
              localStorage.setItem(KEY, "1");
            } catch {}
            setHidden(true);
          }}
          aria-label="Hide checklist"
          className={data.lastProject ? "" : "ml-auto"}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-black/[.06] dark:bg-white/[.08]">
        <div className="h-1 rounded-full" style={{ width: `${(tried / data.features.length) * 100}%`, background: "var(--accent)" }} />
      </div>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {data.features.map((f) => (
          <li key={f.id} className="flex items-center gap-1.5">
            {f.tried ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <Circle className="h-3.5 w-3.5 shrink-0" style={muted} />}
            <span className={f.tried ? "line-through opacity-60" : ""}>{f.label}</span>
            {!f.tried &&
              (f.prompt ? (
                <button onClick={() => setTrying(f)} className="ml-auto underline">
                  Try it
                </button>
              ) : f.href ? (
                <Link href={f.href} className="ml-auto underline">
                  Try it
                </Link>
              ) : (
                <span className="ml-auto" style={muted} title={HINTS[f.id]}>
                  How?
                </span>
              ))}
          </li>
        ))}
      </ul>
      {trying && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
          <span>Try “{trying.label}” on</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Project to try it on" className="rounded-md border bg-transparent px-2 py-1">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            disabled={!target}
            onClick={() => {
              sessionStorage.setItem(`seed:${target}`, trying.prompt!);
              router.push(`/projects/${target}`);
            }}
            className="rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            Start
          </button>
          <button onClick={() => setTrying(null)} className="underline" style={muted}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
