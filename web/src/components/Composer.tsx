"use client";

import { inspectZip, type ZipSummary } from "@/lib/zip-inspect";
import { useRef, useState } from "react";
import { useEscape } from "./useEscape";
import { useBrand } from "@/components/BrandProvider";
import { useRouter } from "next/navigation";
import { Download, FileText, GitBranch, Globe, Loader2, Paperclip, X } from "lucide-react";
import EnvRows, { type EnvRow } from "./EnvRows";

const STARTERS = [
  { label: "Coffee shop site", prompt: "A website for a neighbourhood coffee shop with a menu, opening hours, a gallery and an online order form." },
  { label: "Habit tracker", prompt: "A habit tracker with a weekly grid, streaks and a completion rate for each habit." },
  { label: "Party invite with RSVP", prompt: "A party invitation page with a countdown, the schedule, location details and an RSVP form." },
  { label: "Trivia game", prompt: "A trivia quiz game with categories, a timer per question, scoring and a final results screen." },
];

/** Not everything is an app: these go to the workspace assistant ("beyond app building"). */
const GOALS = [
  { label: "Brainstorm ideas for my business", prompt: "Brainstorm ideas for my business. Ask me a few questions first about what I do and who my customers are." },
  { label: "Research my market and competitors", prompt: "Research my market and competitors. Ask me what my product is first, then give me a short, structured overview." },
  { label: "Plan my launch", prompt: "Help me plan the launch of my app: a checklist for the two weeks before and after, with channels and messages." },
  { label: "Prepare a report from my projects", prompt: "Prepare a short report on my projects: what each one does, how far along it is, and what to do next." },
];

const GUIDES: Record<string, string> = {
  Bolt: "In Bolt, use Export → Download to get a ZIP, then import it here.",
  v0: "In v0, open the project and choose Download ZIP (or push to GitHub), then import it here.",
  Replit: "In Replit, use the ⋮ menu → Download as ZIP, or connect GitHub and import the repository.",
  Base44: "Export your app's code to GitHub, then import the repository here.",
  Manus: "Download the generated project as a ZIP, then import it here.",
};

/** Creates a project from a prompt, an import or a starter, then opens the editor. */
export default function Composer({ initialPrompt = "" }: { initialPrompt?: string }) {
  const [value, setValue] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  // Files picked here are uploaded to the new project and sent with the first message.
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | File[]) {
    const picked = Array.from(list);
    const tooBig = picked.find((f) => f.size > 20 * 1024 * 1024);
    if (tooBig) setError(`${tooBig.name} is larger than 20 MB.`);
    setFiles((cur) => {
      const all = [...cur, ...picked.filter((f) => f.size <= 20 * 1024 * 1024)];
      if (all.length > 10) setError(`Up to 10 files per message; ${all.length - 10} were left out.`);
      return all.slice(0, 10);
    });
  }
  const [env, setEnv] = useState<EnvRow[]>([{ name: "", value: "" }]);
  const router = useRouter();

  async function submit(force = false) {
    const prompt = value.trim() || (files.length ? "Build an app based on the attached files." : "");
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: prompt.slice(0, 60), force, env: envOpen ? env : [] }),
      });
      if (res.status === 409) {
        const d = await res.json();
        setDuplicate(d.project);
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not create the project");
      const { project } = await res.json();
      // One file per request, with progress: a slow or failed file never loses the prompt or the others.
      const sent: unknown[] = [];
      const failed: string[] = [];
      for (const [i, f] of files.entries()) {
        setProgress(`Uploading ${i + 1} of ${files.length}…`);
        const form = new FormData();
        form.append("file", f, f.name);
        const up = await fetch(`/api/projects/${project.id}/uploads`, { method: "POST", body: form }).catch(() => null);
        const d = await up?.json().catch(() => ({}));
        if (up?.ok && d?.attachments?.length) sent.push(...d.attachments);
        else failed.push(f.name);
      }
      if (sent.length) sessionStorage.setItem(`seedFiles:${project.id}`, JSON.stringify(sent));
      const note = failed.length ? `\n\n(These files couldn't be uploaded: ${failed.join(", ")}.)` : "";
      sessionStorage.setItem(`seed:${project.id}`, prompt + note);
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        className={`rounded-3xl border p-3.5 transition-shadow focus-within:ring-2 focus-within:ring-[var(--accent-soft)] ${dragging ? "ring-2 ring-[var(--accent)]" : ""}`}
        style={{ background: "var(--panel)", boxShadow: "var(--shadow-surface)" }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached files">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex max-w-56 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs">
                {f.type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={URL.createObjectURL(f)} alt="" className="h-5 w-5 rounded object-cover" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                )}
                <span className="truncate">{f.name}</span>
                <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDuplicate(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          rows={3}
          disabled={busy}
          autoFocus={!!initialPrompt}
          aria-label="Describe your app"
          placeholder="Describe the app you want to build…"
          className="w-full resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:opacity-50 disabled:opacity-60"
        />
        <div className="flex items-center justify-between pt-1.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            aria-label="Attach files"
            title="Attach images, documents or designs"
            className="grid h-7 w-7 place-items-center rounded-lg hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            style={{ color: "var(--muted)" }}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <button
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            style={{ color: "var(--muted)" }}
          >
            <Download className="h-3.5 w-3.5" /> Import
          </button>
          <button
            onClick={() => setEnvOpen((o) => !o)}
            aria-expanded={envOpen}
            className="mr-auto ml-1 rounded-lg px-2 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            style={{ color: "var(--muted)" }}
          >
            Environment variables (optional)
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
              {busy ? progress || "Creating…" : "Ctrl ↵ to start"}
            </span>
            <button
              onClick={() => void submit()}
              disabled={busy || (!value.trim() && !files.length)}
              className="btn-primary rounded-xl px-4 py-1.5 text-sm font-medium"
            >
              Build
            </button>
          </div>
        </div>
      </div>

      {envOpen && (
        <div className="mt-2 rounded-2xl border p-3" style={{ background: "var(--panel)" }} aria-label="Environment variables">
          <EnvRows rows={env} onChange={setEnv} />
        </div>
      )}

      {duplicate && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs" role="alert">
          <span>You already started this project today.</span>
          <span className="flex gap-2">
            <button onClick={() => router.push(`/projects/${duplicate.id}`)} className="font-medium hover:underline">
              Open it
            </button>
            <button onClick={() => void submit(true)} className="hover:underline" style={{ color: "var(--muted)" }}>
              Start a new one
            </button>
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap justify-center gap-1.5">
        {STARTERS.map((s) => (
          <button
            key={s.label}
            onClick={() => setValue(s.prompt)}
            className="rounded-full border px-3 py-1 text-xs transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap justify-center gap-1.5" aria-label="Beyond app building">
        {GOALS.map((g) => (
          <a
            key={g.label}
            href={`/assistant?prompt=${encodeURIComponent(g.prompt)}`}
            className="rounded-full px-3 py-1 text-xs transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
            style={{ color: "var(--muted)" }}
          >
            {g.label}
          </a>
        ))}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
    </div>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const router = useRouter();
  const brand = useBrand();
  const [tab, setTab] = useState<"github" | "zip" | "website" | "other">("github");
  // A chosen ZIP waits here, inspected, until the import is confirmed.
  const [zipCheck, setZipCheck] = useState<{ file: File; summary: ZipSummary | null; error?: string } | null>(null);
  const [url, setUrl] = useState("");
  // For a private repository: used for this import only, never stored.
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function done(res: Response) {
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.error ?? "Import failed");
      setBusy(false);
      return;
    }
    if (d.seed) sessionStorage.setItem(`seed:${d.project.id}`, d.seed);
    router.push(`/projects/${d.project.id}`);
  }

  async function importUrl() {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    await done(
      await fetch("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: tab, url: url.trim(), ...(tab === "github" && token.trim() ? { token: token.trim() } : {}) }),
      }),
    );
  }

  async function importZip(file: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    await done(await fetch("/api/projects/import", { method: "POST", body: form }));
  }

  const tabs = [
    ["github", "GitHub", GitBranch],
    ["zip", "ZIP file", Download],
    ["website", "Website", Globe],
    ["other", "Other builders", Download],
  ] as const;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Import a project"
        className="w-full max-w-md rounded-2xl border p-5 shadow-2xl"
        style={{ background: "var(--panel)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Import a project</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 hover:bg-black/[.05]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 flex gap-0.5" role="tablist">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id);
                setError(null);
              }}
              className={`rounded-md px-2.5 py-1 text-xs ${tab === id ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "github" && (
            <>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Paste a GitHub or GitLab repository URL. Dependencies and build output are left out. Private
                GitHub repositories use your GitHub connector, or a token you paste below.
              </p>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                aria-label="Repository URL"
                className="mt-2 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              />
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                autoComplete="off"
                placeholder="Access token for a private repository (optional, not saved)"
                aria-label="Access token"
                className="mt-2 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              />
            </>
          )}
          {tab === "website" && (
            <>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Only what visitors can see is read. Logins, databases and other backends are not copied — the agent
                rebuilds the site from its structure and content.
              </p>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                aria-label="Website URL"
                className="mt-2 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              />
            </>
          )}
          {tab === "zip" && (
            <>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Up to 100 MB. Leave out node_modules and build folders — they are skipped anyway.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setZipCheck({ file, summary: null });
                  try {
                    setZipCheck({ file, summary: await inspectZip(file, brand.shortName) });
                  } catch {
                    setZipCheck({ file, summary: null, error: "That isn't a readable ZIP file." });
                  }
                }}
              />
              {zipCheck ? (
                <div className="mt-2 rounded-lg border p-3 text-xs" aria-label="ZIP contents">
                  <p className="font-medium">{zipCheck.file.name}</p>
                  {zipCheck.error ? (
                    <p className="mt-1 text-red-600">{zipCheck.error}</p>
                  ) : !zipCheck.summary ? (
                    <p className="mt-1" style={{ color: "var(--muted)" }}>Looking inside…</p>
                  ) : (
                    <>
                      <p className="mt-1" style={{ color: "var(--muted)" }}>
                        {zipCheck.summary.framework} · {zipCheck.summary.files} files · {(zipCheck.summary.bytes / 1024 / 1024).toFixed(1)} MB
                        {zipCheck.summary.skipped ? ` · ${zipCheck.summary.skipped} skipped (dependencies, build output, .git)` : ""}
                      </p>
                      {zipCheck.summary.top.length > 0 && (
                        <p className="mt-1 truncate font-mono text-[11px]" style={{ color: "var(--muted)" }}>
                          {zipCheck.summary.top.join("  ")}
                        </p>
                      )}
                      {zipCheck.summary.warnings.map((w) => (
                        <p key={w} className="mt-1 text-amber-700 dark:text-amber-400">{w}</p>
                      ))}
                    </>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => setZipCheck(null)} disabled={busy} className="rounded-lg border px-3 py-1.5">
                      Choose another
                    </button>
                    <button
                      onClick={() => void importZip(zipCheck.file)}
                      disabled={busy || !zipCheck.summary}
                      className="btn-primary rounded-lg px-3 py-1.5 disabled:opacity-50"
                    >
                      {busy ? "Importing…" : "Import"}
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => fileRef.current?.click()} disabled={busy} className="mt-2 w-full rounded-lg border border-dashed px-3 py-6 text-sm">
                  Choose a ZIP file
                </button>
              )}
            </>
          )}
          {tab === "other" && (
            <ul className="space-y-2 text-xs">
              {Object.entries(GUIDES).map(([name, how]) => (
                <li key={name}>
                  <span className="font-medium">{name}: </span>
                  <span style={{ color: "var(--muted)" }}>{how}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}

        {(tab === "github" || tab === "website") && (
          <div className="mt-4 flex justify-end">
            <button
              onClick={importUrl}
              disabled={busy || !url.trim()}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
