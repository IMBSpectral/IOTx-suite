"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { useEscape } from "./useEscape";
import RoutePreviews from "./RoutePreviews";
import { Check, Copy, ExternalLink, Globe, Loader2, Lock, Users, X } from "lucide-react";
import SiteMembers from "./SiteMembers";
import SetupReview from "./SetupReview";
import { usePerms } from "./iotx/PermsProvider";

type Status = "passed" | "warning" | "failed" | "skipped";
type CheckItem = { severity: string; title: string; detail?: string; file?: string };
type CheckRow = { id: string; label: string; status: Status; summary: string; items: CheckItem[] };
type Checks = { at: string; sha: string; checks: CheckRow[]; blocking: boolean };
type Seo = { title?: string; description?: string; ogImage?: string; favicon?: string; pages?: Record<string, { title?: string; description?: string; ogImage?: string }> };

export type PublishInfo = {
  published: boolean;
  upToDate: boolean;
  url: string | null;
  subdomain: string;
  audience: "public" | "workspace" | "private";
  showBadge: boolean;
  /** What the workspace's plan allows when publishing. */
  entitlements?: { hideBadge: boolean; customDomain: boolean; plan: string };
  seo: Seo;
  lastChecks: Checks | null;
  requestedAt: string | null;
  requiresApproval: boolean;
  canApprove: boolean;
  publishedAt: string | null;
  pageDefaults?: { title: string; description: string };
};

const STEPS = [
  { id: "checking", label: "Checking for changes" },
  { id: "building", label: "Building your app" },
  { id: "checks", label: "Running security and SEO checks" },
  { id: "applying", label: "Applying updates" },
  { id: "live", label: "Live" },
];

// Published apps live on subdomains of the host the editor is served from.
const sitesHost = () => (typeof window === "undefined" ? "localhost:3000" : window.location.host);
const sitesProtocol = () => (typeof window === "undefined" ? "http:" : window.location.protocol);

const dot: Record<Status, string> = {
  passed: "bg-emerald-500",
  warning: "bg-amber-500",
  failed: "bg-red-500",
  skipped: "bg-zinc-300",
};

/** The label the publish button shows, from the current state. */
export function publishLabel(info: PublishInfo | null, busy: boolean) {
  if (busy) return "Publishing…";
  if (!info) return "Publish";
  if (info.requestedAt && info.requiresApproval) return "Awaiting approval";
  if (!info.published) return "Publish";
  return info.upToDate ? "Up to date" : "Publish changes";
}

export default function PublishDialog({
  projectId,
  open,
  onClose,
  onInfo,
  onFix,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onInfo: (info: PublishInfo) => void;
  onFix: (message: string) => void;
}) {
  const [info, setInfo] = useState<PublishInfo | null>(null);
  const brand = useBrand();
  const [seo, setSeo] = useState<Seo>({});
  const [sub, setSub] = useState("");
  const canRename = usePerms().can("builder.domain.subdomain");
  const [phase, setPhase] = useState<"idle" | "running" | "live" | "blocked" | "error">("idle");
  const [step, setStep] = useState<string | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);
  // What the publish did to the live app's data: database changes applied, records copied from Test.
  const [dataNote, setDataNote] = useState<{ created: boolean; applied: number; failed: string[]; copied: { table: string; rows: number }[]; skipped: { table: string; reason: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Why the last address change was refused, shown under the address box.
  const [addrError, setAddrError] = useState<string | null>(null);
  const lastError = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  useEscape(open ? close : null);

  const apply = useCallback(
    (d: PublishInfo | null) => {
      if (!d) return;
      setInfo(d);
      setSeo(d.seo ?? {});
      setSub(d.subdomain);
      setChecks(d.lastChecks);
      onInfo(d);
    },
    [onInfo],
  );

  const fetchInfo = useCallback(
    () =>
      fetch(`/api/projects/${projectId}/publish`)
        .then((r) => (r.ok ? (r.json() as Promise<PublishInfo>) : null))
        .catch(() => null),
    [projectId],
  );
  const load = useCallback(() => fetchInfo().then(apply), [fetchInfo, apply]);

  // Refreshed on mount (for the button label) and whenever the dialog opens.
  useEffect(() => {
    let live = true;
    fetchInfo().then((d) => live && apply(d));
    return () => {
      live = false;
    };
  }, [open, fetchInfo, apply]);

  function close() {
    // Reset the run state here rather than on open, so reopening starts clean.
    setPhase("idle");
    setError(null);
    onClose();
  }

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/publish`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      lastError.current = d.error ?? "Could not save";
      setError(lastError.current);
      return false;
    }
    setInfo((i) => (i ? { ...i, ...d } : d));
    onInfo({ ...(info as PublishInfo), ...d });
    return true;
  }

  async function run(action: "publish" | "check" | "request") {
    setError(null);
    if (action === "request") {
      const res = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) void load();
      return;
    }
    setPhase("running");
    setStep("checking");
    const res = await fetch(`/api/projects/${projectId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      setPhase("error");
      setError(d.error ?? "Publish failed");
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        if (!p.startsWith("data: ")) continue;
        const ev = JSON.parse(p.slice(6));
        if (ev.type === "step") setStep(ev.step);
        else if (ev.type === "published") {
          setChecks(ev.checks);
          setDataNote(
            ev.liveDb && (ev.liveDb.created || ev.liveDb.applied?.length || ev.liveDb.failed?.length || ev.records?.tables?.length || ev.records?.skipped?.length)
              ? {
                  created: !!ev.liveDb.created,
                  applied: ev.liveDb.applied?.length ?? 0,
                  failed: (ev.liveDb.failed ?? []).map((f: { error: string }) => f.error),
                  copied: ev.records?.tables ?? [],
                  skipped: ev.records?.skipped ?? [],
                }
              : null,
          );
          setPhase("live");
        } else if (ev.type === "checks") {
          setChecks(ev.result);
          setPhase(ev.result.blocking ? "blocked" : "idle");
        } else if (ev.type === "blocked") {
          setChecks(ev.result);
          setPhase("blocked");
        } else if (ev.type === "error") {
          setPhase("error");
          setError(ev.message);
        }
      }
    }
    void load();
  }

  async function unpublish() {
    await fetch(`/api/projects/${projectId}/publish`, { method: "DELETE" });
    void load();
  }

  function fixMessage() {
    const failed = (checks?.checks ?? []).filter((c) => c.status === "failed");
    const lines = failed.flatMap((c) =>
      c.items.map((i) => `- [${c.label}] ${i.title}${i.file ? ` (${i.file})` : ""}${i.detail ? `: ${i.detail}` : ""}`),
    );
    return `Publishing is blocked. Fix these problems:\n\n${lines.join("\n").slice(0, 6000)}`;
  }

  if (!open) return null;
  const url = `${sitesProtocol()}//${sub || info?.subdomain}.${sitesHost()}`;
  const live = info?.published && info.url;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[8vh]" onClick={close}>
      <div
        role="dialog"
        aria-label="Publish"
        className="max-h-[84vh] w-full max-w-[560px] overflow-y-auto rounded-2xl border shadow-2xl"
        style={{ background: "var(--panel)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">Publish</h2>
            <p className="text-[11px]" style={{ color: "var(--muted)" }}>
              {info?.published
                ? info.upToDate
                  ? "Your latest version is live."
                  : "You have changes that aren't published yet."
                : "Put the latest version of your app online."}
            </p>
          </div>
          <button onClick={close} aria-label="Close" className="rounded-md p-1 hover:bg-black/[.05]">
            <X className="h-4 w-4" />
          </button>
        </header>

        <OpenDraftNote projectId={projectId} open={open} />
        <SetupReview projectId={projectId} open={open} />

        {phase === "running" && (
          <section className="px-5 py-4">
            <ol className="space-y-2">
              {STEPS.map((s, i) => {
                const current = STEPS.findIndex((x) => x.id === step);
                const state = i < current ? "done" : i === current ? "active" : "todo";
                return (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    {state === "done" ? (
                      <Check className="h-4 w-4 text-emerald-600" />
                    ) : state === "active" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <span className="h-4 w-4 rounded-full border" />
                    )}
                    <span style={state === "todo" ? { color: "var(--muted)" } : undefined}>{s.label}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {phase === "live" && info?.url && (
          <section className="border-b px-5 py-4">
            <p className="text-sm font-medium">Your website is live 🎉</p>
            <div className="mt-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{info.url}</span>
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(info.url!).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded p-1 hover:bg-black/[.05]"
                aria-label="Copy link"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <a href={info.url} target="_blank" rel="noreferrer" className="rounded p-1 hover:bg-black/[.05]" aria-label="Open site">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
            <button
              onClick={() =>
                navigator.clipboard
                  .writeText(`Check out what I just built: ${info.url}`)
                  .catch(() => undefined)
              }
              className="mt-2 text-[11px] hover:underline"
              style={{ color: "var(--muted)" }}
            >
              Copy a share message
            </button>
            {dataNote && (
              <div className="mt-3 rounded-lg border px-3 py-2 text-[11px]" style={{ color: "var(--muted)" }} aria-label="Live data">
                <p className="font-medium" style={{ color: "var(--fg)" }}>Live data</p>
                {dataNote.created && <p>The live app got its own database, a copy of the preview&apos;s data and accounts.</p>}
                {dataNote.applied > 0 && <p>{dataNote.applied} database change{dataNote.applied > 1 ? "s" : ""} applied to the live app.</p>}
                {dataNote.copied.length > 0 && (
                  <p>
                    Copied from the preview: {dataNote.copied.map((c) => `${c.rows} ${c.table === "auth_users" ? (c.rows > 1 ? "accounts" : "account") : `in ${c.table}`}`).join(", ")}.
                    Records already on the live app were left as they are.
                  </p>
                )}
                {dataNote.failed.map((f, i) => (
                  <p key={i} className="text-red-600">A database change couldn&apos;t be applied to the live app: {f}</p>
                ))}
                {dataNote.skipped.map((s, i) => (
                  <p key={i}>Not copied{s.table ? ` (${s.table})` : ""}: {s.reason}.</p>
                ))}
              </div>
            )}
          </section>
        )}

        {(phase === "blocked" || phase === "error") && (
          <section className="border-b px-5 py-4" role="alert">
            <p className="text-sm font-medium text-red-600">
              {phase === "blocked" ? "Publishing is blocked" : "Publish failed"}
            </p>
            {error && <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--muted)" }}>{error}</p>}
            {phase === "blocked" && (
              <button
                onClick={() => {
                  onFix(fixMessage());
                  close();
                }}
                className="mt-2 rounded-md bg-[#6d4aff] px-3 py-1.5 text-xs font-medium text-white"
              >
                Fix with {brand.shortName}
              </button>
            )}
          </section>
        )}

        <section className="border-b px-5 py-4" aria-label="Where should your app run?">
          <p className="mb-2 text-xs font-medium">Where should your app run?</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-[#6d4aff] p-2.5 text-xs">
              <p className="font-medium">
                {brand.name} <span className="ml-1 rounded-full bg-[#6d4aff]/10 px-1.5 py-px text-[10px] text-[#6d4aff]">Recommended</span>
              </p>
              <p className="mt-0.5" style={{ color: "var(--muted)" }}>
                Managed hosting: publishing, custom domains, analytics and access control handled for you.
              </p>
            </div>
            <div className="rounded-lg border p-2.5 text-xs">
              <p className="font-medium">Your own server</p>
              <p className="mt-0.5" style={{ color: "var(--muted)" }}>
                Download the published build with a Dockerfile, for any static host or your cloud.
              </p>
              {info?.published ? (
                <a href={`/api/projects/${projectId}/export?target=selfhost`} className="mt-1.5 inline-block font-medium underline" download>
                  Download build
                </a>
              ) : (
                <p className="mt-1.5" style={{ color: "var(--muted)" }}>
                  Publish once to download it.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="space-y-3 border-b px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium">Address</span>
            <div className="mt-1 flex items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center rounded-lg border px-2 py-1 font-mono text-xs">
                <span style={{ color: "var(--muted)" }}>{sitesProtocol()}//</span>
                <input
                  value={sub}
                  onChange={(e) => {
                    setSub(e.target.value.toLowerCase());
                    setAddrError(null);
                  }}
                  aria-label="Subdomain"
                  readOnly={!canRename}
                  title={canRename ? undefined : "Choosing the subdomain isn't turned on for your role"}
                  className="min-w-0 flex-1 bg-transparent outline-none"
                />
                <span style={{ color: "var(--muted)" }}>.{sitesHost()}</span>
              </div>
              {sub !== info?.subdomain && (
                <button
                  disabled={saving}
                  onClick={async () => {
                    setAddrError(null);
                    if (!(await save({ subdomain: sub }))) setAddrError(lastError.current ?? "Couldn't save this address.");
                  }}
                  className="rounded-md border px-2 py-1 text-xs"
                >
                  Save
                </button>
              )}
            </div>
            {addrError && (
              <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                {addrError}
              </p>
            )}
          </label>

          <fieldset>
            <legend className="text-xs font-medium">Who can open it</legend>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {(
                [
                  ["public", "Anyone", Globe],
                  ["workspace", "Workspace", Users],
                  ["private", "Invited only", Lock],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  onClick={() => void save({ audience: value })}
                  aria-pressed={info?.audience === value}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs ${
                    info?.audience === value ? "border-[#6d4aff] bg-[#6d4aff]/10 font-medium" : ""
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
            {info && info.audience !== "public" && <div className="mt-2"><SiteMembers projectId={projectId} audience={info.audience} canManage /></div>}
          </fieldset>

          <label className="flex items-center justify-between text-xs">
            <span>
              Show the &ldquo;Edit with {brand.name}&rdquo; badge
              {info?.entitlements && !info.entitlements.hideBadge && (
                <span className="ml-1.5 rounded bg-[#6d4aff]/10 px-1 py-px text-[10px] font-medium text-[#6d4aff]">Paid plans can hide it</span>
              )}
            </span>
            <input
              type="checkbox"
              checked={info?.showBadge ?? true}
              disabled={!!info?.entitlements && !info.entitlements.hideBadge && (info?.showBadge ?? true)}
              onChange={(e) => void save({ showBadge: e.target.checked })}
            />
          </label>
        </section>

        <section className="space-y-2 border-b px-5 py-4">
          <p className="text-xs font-medium">Search and social appearance</p>
          <input
            value={seo.title ?? ""}
            onChange={(e) => setSeo((s) => ({ ...s, title: e.target.value }))}
            placeholder={info?.pageDefaults?.title || "Page title"}
            aria-label="Page title"
            maxLength={120}
            className="w-full rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
          />
          <textarea
            value={seo.description ?? ""}
            onChange={(e) => setSeo((s) => ({ ...s, description: e.target.value }))}
            placeholder={info?.pageDefaults?.description || "Description shown in search results and link previews"}
            aria-label="Description"
            maxLength={300}
            rows={2}
            className="w-full resize-none rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={seo.ogImage ?? ""}
              onChange={(e) => setSeo((s) => ({ ...s, ogImage: e.target.value }))}
              placeholder="Share image URL (or /image.png)"
              aria-label="Share image"
              className="rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
            />
            <input
              value={seo.favicon ?? ""}
              onChange={(e) => setSeo((s) => ({ ...s, favicon: e.target.value }))}
              placeholder="Favicon URL (or /favicon.png)"
              aria-label="Favicon"
              className="rounded-lg border bg-transparent px-2 py-1 text-xs outline-none"
            />
          </div>

          {/* How the link looks when shared, and in a search result. */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="overflow-hidden rounded-lg border">
              <div
                className="h-16 bg-cover bg-center"
                style={{
                  background: seo.ogImage
                    ? `center / cover no-repeat url(${seo.ogImage.startsWith("/") ? url + seo.ogImage : seo.ogImage})`
                    : "linear-gradient(135deg,#e7e5e4,#f5f5f4)",
                }}
              />
              <div className="p-2">
                <p className="truncate text-[11px] font-medium">{seo.title || info?.pageDefaults?.title || "Untitled page"}</p>
                <p className="line-clamp-2 text-[10px]" style={{ color: "var(--muted)" }}>
                  {seo.description || info?.pageDefaults?.description || "No description"}
                </p>
              </div>
            </div>
            <div className="rounded-lg border p-2">
              <p className="truncate text-[10px]" style={{ color: "var(--muted)" }}>{url}</p>
              <p className="truncate text-[12px] text-[#1a0dab] dark:text-[#8ab4f8]">{seo.title || info?.pageDefaults?.title || "Untitled page"}</p>
              <p className="line-clamp-2 text-[10px]" style={{ color: "var(--muted)" }}>
                {seo.description || info?.pageDefaults?.description || "Search engines will pick text from the page."}
              </p>
            </div>
          </div>
          {info && <RoutePreviews projectId={projectId} seo={seo} setSeo={setSeo} />}
          <div className="flex justify-end">
            <button
              disabled={saving}
              onClick={() => void save({ seo })}
              className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save appearance"}
            </button>
          </div>
        </section>

        <section className="border-b px-5 py-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">Checks</p>
            <button
              disabled={phase === "running"}
              onClick={() => void run("check")}
              className="text-[11px] hover:underline disabled:opacity-50"
              style={{ color: "var(--muted)" }}
            >
              Run checks
            </button>
          </div>
          {!checks && (
            <p className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
              Build, security, dependency and SEO checks run before every publish.
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {checks?.checks.map((c) => (
              <li key={c.id} className="rounded-lg border">
                <button
                  onClick={() => setOpenCheck((o) => (o === c.id ? null : c.id))}
                  aria-expanded={openCheck === c.id}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dot[c.status]}`} aria-hidden />
                  <span className="text-xs font-medium">{c.label}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-[11px]" style={{ color: "var(--muted)" }}>
                    {c.summary}
                  </span>
                </button>
                {openCheck === c.id && c.items.length > 0 && (
                  <ul className="space-y-1 border-t px-2.5 py-1.5">
                    {c.items.slice(0, 20).map((it, i) => (
                      <li key={i} className="text-[11px]">
                        <span className="font-medium">{it.title}</span>
                        <span style={{ color: "var(--muted)" }}>
                          {it.file ? ` · ${it.file}` : ""}
                          {it.detail ? ` — ${it.detail.slice(0, 200)}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>

        <footer className="flex items-center justify-between gap-2 px-5 py-3">
          <div>
            {info?.published && (
              <button onClick={() => void unpublish()} className="text-xs hover:underline" style={{ color: "var(--muted)" }}>
                Unpublish
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {live && (
              <a href={info!.url!} target="_blank" rel="noreferrer" className="rounded-lg border px-3 py-1.5 text-xs">
                Open site
              </a>
            )}
            {info?.requiresApproval ? (
              <button
                disabled={!!info.requestedAt}
                onClick={() => void run("request")}
                className="rounded-lg bg-[#6d4aff] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {info.requestedAt ? "Waiting for approval" : "Request approval"}
              </button>
            ) : (
              <button
                disabled={phase === "running"}
                onClick={() => void run("publish")}
                className="rounded-lg bg-[#6d4aff] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {phase === "running"
                  ? "Publishing…"
                  : info?.requestedAt && info.canApprove
                    ? "Approve and publish"
                    : info?.published
                      ? info.upToDate
                        ? "Republish"
                        : "Publish changes"
                      : "Publish"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

type DraftInfo = { id: string; name: string; behind: boolean; status: string };

/**
 * Publishing puts the accepted version online, so an open draft's changes
 * aren't included. A draft that is behind must catch up before it can be
 * accepted (and so published).
 */
function OpenDraftNote({ projectId, open }: { projectId: string; open: boolean }) {
  const [draft, setDraft] = useState<DraftInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch(`/api/projects/${projectId}/drafts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { current: string | null; drafts: DraftInfo[] } | null) => {
        if (live) setDraft(d?.drafts.find((x) => x.id === d.current) ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, open, version]);

  if (!draft) return null;
  async function sync() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/drafts/${draft!.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sync" }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) setError(d.error ?? "Couldn't update the draft.");
    setVersion((v) => v + 1);
  }
  return (
    <section className="mx-5 mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-950/30" aria-label="Open draft">
      <p>
        You&apos;re working in the draft <span className="font-medium">{draft.name}</span>. Publishing puts the accepted version
        online, without this draft&apos;s changes. Accept the draft first to publish them.
      </p>
      {draft.behind && (
        <div className="mt-2 flex items-center gap-2">
          <button onClick={sync} disabled={busy} className="rounded-lg border bg-white px-2.5 py-1 font-medium disabled:opacity-50 dark:bg-transparent">
            {busy ? "Updating…" : "Update this draft with the latest changes"}
          </button>
          <span style={{ color: "var(--muted)" }}>It&apos;s behind the project and can&apos;t be accepted until it catches up.</span>
        </div>
      )}
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </section>
  );
}
