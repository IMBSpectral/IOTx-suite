"use client";

import PentestSection from "./PentestSection";
import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
type Finding = {
  id: string;
  rule: string;
  title: string;
  category: string;
  severity: Severity;
  file: string;
  line: number | null;
  ignored: boolean;
  ignoreReason: string | null;
};
type CheckMeta = {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  looksFor: string;
  appliesWhen: string;
  passesWhen: string;
  enabled: boolean;
};
type Pkg = {
  name: string;
  severity: string;
  range: string;
  fixAvailable: boolean;
  advisories: { id: string; title: string; url?: string; severity: string }[];
};
type Data = {
  checks: CheckMeta[];
  findings: Finding[];
  audit: { at: string; packages: Pkg[]; error?: string } | null;
  memory: string;
  lastScanAt: string | null;
  deepScan: {
    at: string;
    summary: string;
    count: number;
    credits: number;
    truncated: boolean;
  } | null;
};

const SEV: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white",
  HIGH: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  MEDIUM:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  LOW: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  INFO: "bg-zinc-100 text-zinc-600",
  critical: "bg-red-600 text-white",
  high: "bg-red-100 text-red-800",
  moderate: "bg-amber-100 text-amber-800",
  low: "bg-zinc-100 text-zinc-700",
};

export type FixQueued = {
  buildId: string;
  userMessageId: string;
  messageId: string;
  prompt: string;
};

/** Security center: findings, dependencies, checks and security notes. */
export default function SecurityCenter({
  projectId,
  onFixQueued,
}: {
  projectId: string;
  onFixQueued: (f: FixQueued) => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<
    "findings" | "dependencies" | "checks" | "memory"
  >("findings");
  const [scanning, setScanning] = useState(false);
  const [memory, setMemory] = useState("");
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deepScanning, setDeepScanning] = useState(false);

  const fetchData = useCallback(
    () =>
      fetch(`/api/projects/${projectId}/security`)
        .then((r) => (r.ok ? (r.json() as Promise<Data>) : null))
        .catch(() => null),
    [projectId],
  );
  const apply = useCallback((d: Data | null) => {
    if (!d) return;
    setData(d);
    setMemory(d.memory);
  }, []);

  useEffect(() => {
    let live = true;
    fetchData().then((d) => live && apply(d));
    return () => {
      live = false;
    };
  }, [fetchData, apply]);

  async function act(body: Record<string, unknown>) {
    const res = await fetch(`/api/projects/${projectId}/security`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) setNotice(d.error ?? "That didn't work.");
    return { ok: res.ok, d };
  }

  async function scan() {
    setScanning(true);
    setNotice(null);
    await act({ action: "scan" });
    apply(await fetchData());
    setScanning(false);
  }

  /** The optional AI review of the whole codebase; it costs credits, so it asks first. */
  async function deep() {
    if (
      !confirm(
        "Run a deep scan? An AI reviews all of the app's code for security problems the automatic checks can't see. It uses credits, like a chat message, and takes a minute or two.",
      )
    )
      return;
    setDeepScanning(true);
    setNotice(null);
    const { ok, d } = await act({ action: "deep-scan" });
    if (!ok)
      setNotice(
        (d as { error?: string }).error ?? "The deep scan couldn't finish.",
      );
    apply(await fetchData());
    setDeepScanning(false);
  }

  async function fix(ids: string[]) {
    const { ok, d } = await act({ action: "fix", findingIds: ids });
    if (ok) {
      onFixQueued(d as FixQueued);
      setNotice("Fix queued in chat. Security fixes use no credits.");
    }
  }

  async function ignore(f: Finding) {
    const reason = window.prompt(
      `Why is "${f.title}" not a problem here?`,
      "This is intended",
    );
    if (!reason?.trim()) return;
    await act({ action: "ignore", findingId: f.id, reason });
    apply(await fetchData());
  }

  const open = data?.findings.filter((f) => !f.ignored) ?? [];
  const ignored = data?.findings.filter((f) => f.ignored) ?? [];
  const counts = open.reduce<Record<string, number>>(
    (m, f) => ({ ...m, [f.severity]: (m[f.severity] ?? 0) + 1 }),
    {},
  );
  const categories = [...new Set(data?.checks.map((c) => c.category) ?? [])];

  const tabBtn = (t: typeof tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={`rounded-md px-2.5 py-1 text-xs ${tab === t ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <ShieldCheck className="h-4 w-4" /> Security
            </h2>
            <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
              {data?.checks.filter((c) => c.enabled).length ?? 0} checks run
              automatically before every publish. Scans and fixes use no
              credits; a deep scan does.
              {data?.lastScanAt
                ? ` Last scan ${new Date(data.lastScanAt).toLocaleString()}.`
                : ""}
            </p>
          </div>
          <span className="flex shrink-0 gap-1.5">
            <button
              onClick={deep}
              disabled={deepScanning || scanning}
              title="AI review of the whole codebase (uses credits)"
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60"
            >
              {deepScanning && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {deepScanning ? "Deep scanning…" : "Deep scan"}
            </button>
            <button
              onClick={scan}
              disabled={scanning}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#6d4aff] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            >
              {scanning && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {scanning ? "Scanning…" : "Scan now"}
            </button>
          </span>
        </div>

        {data?.deepScan && (
          <p
            className="mt-3 rounded-lg border px-3 py-2 text-xs"
            data-testid="deep-scan-summary"
          >
            <span className="font-medium">Deep scan</span> ·{" "}
            {new Date(data.deepScan.at).toLocaleString()} ·{" "}
            {data.deepScan.count} finding{data.deepScan.count === 1 ? "" : "s"}{" "}
            · {data.deepScan.credits} credit
            {data.deepScan.credits === 1 ? "" : "s"}
            <span className="mt-0.5 block" style={{ color: "var(--muted)" }}>
              {data.deepScan.summary}
              {data.deepScan.truncated
                ? " Some generic UI files were left out to fit."
                : ""}
            </span>
          </p>
        )}

        {notice && (
          <p className="mt-3 rounded-lg border px-3 py-2 text-xs" role="status">
            {notice}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((s) => (
            // A zero count stays quiet; colour only means there is something to look at.
            <span
              key={s}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${counts[s] ? SEV[s] : "border"}`}
              style={counts[s] ? undefined : { color: "var(--muted)" }}
            >
              {counts[s] ?? 0} {s.toLowerCase()}
            </span>
          ))}
          <span className="rounded-full border px-2.5 py-1 text-[11px]">
            {ignored.length} ignored
          </span>
          <span className="rounded-full border px-2.5 py-1 text-[11px]">
            {data?.audit?.packages.length ?? 0} vulnerable dependencies
          </span>
        </div>

        <div className="mt-4 flex gap-0.5 border-b pb-2" role="tablist">
          {tabBtn("findings", "Findings")}
          {tabBtn("dependencies", "Dependencies")}
          {tabBtn("checks", "Checks")}
          {tabBtn("memory", "Security notes")}
        </div>

        {tab === "findings" && (
          <section className="mt-3">
            {open.length > 1 && (
              <div className="mb-2 flex justify-end">
                <button
                  onClick={() => fix(open.map((f) => f.id))}
                  className="rounded-md border px-2.5 py-1 text-xs"
                >
                  Fix all ({open.length})
                </button>
              </div>
            )}
            {open.length === 0 && (
              <p
                className="py-6 text-center text-sm"
                style={{ color: "var(--muted)" }}
              >
                {data?.lastScanAt
                  ? "No open findings. 🎉"
                  : "Run a scan to check this project."}
              </p>
            )}
            <ul className="space-y-1.5">
              {open.map((f) => (
                <li
                  key={f.id}
                  className="flex items-start gap-3 rounded-lg border px-3 py-2"
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEV[f.severity]}`}
                  >
                    {f.severity}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{f.title}</p>
                    <p
                      className="truncate font-mono text-[11px]"
                      style={{ color: "var(--muted)" }}
                    >
                      {f.file}
                      {f.line ? `:${f.line}` : ""} · {f.category}
                    </p>
                  </div>
                  <button
                    onClick={() => ignore(f)}
                    className="shrink-0 text-xs hover:underline"
                    style={{ color: "var(--muted)" }}
                  >
                    Ignore
                  </button>
                  <button
                    onClick={() => fix([f.id])}
                    className="shrink-0 rounded-md bg-[#6d4aff] px-2.5 py-1 text-xs font-medium text-white"
                  >
                    Fix
                  </button>
                </li>
              ))}
            </ul>
            {ignored.length > 0 && (
              <>
                <h3
                  className="mt-5 text-[11px] font-medium uppercase tracking-wider"
                  style={{ color: "var(--muted)" }}
                >
                  Ignored
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {ignored.map((f) => (
                    <li
                      key={f.id}
                      className="flex items-start gap-3 rounded-lg border border-dashed px-3 py-2 opacity-80"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{f.title}</p>
                        <p
                          className="text-[11px]"
                          style={{ color: "var(--muted)" }}
                        >
                          {f.file} — “{f.ignoreReason}”
                        </p>
                      </div>
                      <button
                        onClick={async () => {
                          await act({ action: "unignore", findingId: f.id });
                          apply(await fetchData());
                        }}
                        className="shrink-0 text-xs hover:underline"
                      >
                        Undo ignore
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {tab === "dependencies" && (
          <section className="mt-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {data?.audit
                  ? (data.audit.error ??
                    `Third-party packages audited ${new Date(data.audit.at).toLocaleString()}.`)
                  : "Run a scan to audit dependencies."}
              </p>
              {data?.audit && !data.audit.error && (
                <span className="flex gap-2 text-xs">
                  <a
                    href={`/api/projects/${projectId}/security/dependencies?format=csv`}
                    className="hover:underline"
                  >
                    Export CSV
                  </a>
                  <a
                    href={`/api/projects/${projectId}/security/dependencies?format=json`}
                    className="hover:underline"
                  >
                    Export JSON
                  </a>
                </span>
              )}
            </div>
            <ul className="space-y-1.5">
              {data?.audit?.packages.map((p) => (
                <li key={p.name} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEV[p.severity] ?? SEV.low}`}
                    >
                      {p.severity}
                    </span>
                    <span className="font-mono text-sm">{p.name}</span>
                    <span
                      className="text-[11px]"
                      style={{ color: "var(--muted)" }}
                    >
                      {p.range}
                    </span>
                    <span
                      className="ml-auto text-[11px]"
                      style={{ color: "var(--muted)" }}
                    >
                      {p.fixAvailable ? "Fix available" : "No fix yet"}
                    </span>
                  </div>
                  {p.advisories.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {p.advisories.map((a, i) => (
                        <li key={i} className="text-[11px]">
                          {a.url ? (
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono hover:underline"
                            >
                              {a.id}
                            </a>
                          ) : (
                            <span className="font-mono">{a.id}</span>
                          )}{" "}
                          <span style={{ color: "var(--muted)" }}>
                            {a.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {tab === "checks" && (
          <section className="mt-3 space-y-4">
            {categories.map((cat) => (
              <div key={cat}>
                <h3
                  className="mb-1.5 text-[11px] font-medium uppercase tracking-wider"
                  style={{ color: "var(--muted)" }}
                >
                  {cat}
                </h3>
                <ul className="space-y-1">
                  {data!.checks
                    .filter((c) => c.category === cat)
                    .map((c) => (
                      <li key={c.id} className="rounded-lg border">
                        <div className="flex items-center gap-2 px-3 py-1.5">
                          <button
                            onClick={() =>
                              setOpenCheck((o) => (o === c.id ? null : c.id))
                            }
                            aria-expanded={openCheck === c.id}
                            className="min-w-0 flex-1 truncate text-left text-sm"
                          >
                            {c.title}
                          </button>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEV[c.severity]}`}
                          >
                            {c.severity}
                          </span>
                          <label className="flex items-center gap-1 text-[11px]">
                            <input
                              type="checkbox"
                              checked={c.enabled}
                              onChange={async (e) => {
                                await act({
                                  action: "toggle",
                                  checkId: c.id,
                                  enabled: e.target.checked,
                                });
                                apply(await fetchData());
                              }}
                            />
                            On
                          </label>
                        </div>
                        {openCheck === c.id && (
                          <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 border-t px-3 py-2 text-[11px]">
                            <dt className="font-medium">Looks for</dt>
                            <dd style={{ color: "var(--muted)" }}>
                              {c.looksFor}
                            </dd>
                            <dt className="font-medium">Applies when</dt>
                            <dd style={{ color: "var(--muted)" }}>
                              {c.appliesWhen}
                            </dd>
                            <dt className="font-medium">Passes when</dt>
                            <dd style={{ color: "var(--muted)" }}>
                              {c.passesWhen}
                            </dd>
                          </dl>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {tab === "memory" && (
          <section className="mt-3">
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Security requirements the agent follows whenever it writes code
              for this project — who may see what, data that must never leave
              the browser, compliance rules.
            </p>
            <textarea
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              rows={8}
              aria-label="Security notes"
              placeholder={
                "e.g.\n- Only signed-in staff may see the orders page.\n- Never log customer email addresses."
              }
              className="mt-2 w-full rounded-lg border bg-transparent p-2.5 text-sm outline-none"
            />
            <div className="mt-2 flex justify-end">
              <button
                onClick={async () => {
                  const { ok } = await act({ action: "memory", text: memory });
                  if (ok)
                    setNotice(
                      "Security notes saved. The agent reads them on every turn.",
                    );
                }}
                className="rounded-md bg-[#6d4aff] px-3 py-1.5 text-xs font-medium text-white"
              >
                Save notes
              </button>
            </div>
          </section>
        )}
        <div className="mt-6">
          <PentestSection projectId={projectId} onFixQueued={onFixQueued} />
        </div>
      </div>
    </div>
  );
}
