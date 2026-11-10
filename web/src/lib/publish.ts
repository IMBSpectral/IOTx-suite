import fs from "node:fs/promises";
import { getBrand } from "./brand";
import { blocks, projectRules } from "./workspace-security";
import { backendFindings } from "./backend-scan";
import path from "node:path";
import { db } from "./db";
import { buildDir, repoDir } from "./paths";
import { scanProject, type Finding } from "./scan";
import { headSha as currentHead, exportTree } from "./repo";

import { ensureSandbox, sandboxExec } from "./sandbox";
import { mapsBuildEnv } from "./google-maps";
import { copyNewRecords, syncLive, type RecordsCopied } from "./cloud-envs";
import { deployIfChanged } from "./cloud-functions";
import { siteOrigin } from "./site-host";
import git from "isomorphic-git";

/**
 * Publishing: run the pre-publish checks, build the accepted version (main)
 * in the project's container, and point the live site at that immutable
 * snapshot. A publish is a pointer move; a rollback is the same pointer moved
 * back. Search/social metadata and the badge are applied when the site is
 * served, so editing them never needs a rebuild.
 */

export type CheckStatus = "passed" | "warning" | "failed" | "skipped";
export type CheckItem = {
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail?: string;
  file?: string;
};
export type Check = {
  id: "build" | "types" | "security" | "dependencies" | "seo";
  label: string;
  status: CheckStatus;
  summary: string;
  items: CheckItem[];
};
export type ChecksResult = { at: string; sha: string; checks: Check[]; blocking: boolean };

export type PageSeo = { title?: string; description?: string; ogImage?: string };
export type Seo = {
  title?: string;
  description?: string;
  ogImage?: string;
  favicon?: string;
  /** Per-page overrides by route path ("/pricing"), for link previews and search. */
  pages?: Record<string, PageSeo>;
};

/** "/pricing/" and "pricing" are the same page as "/pricing". */
export function normalizeRoute(p: string) {
  const s = "/" + p.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  return s === "/" ? "/" : s.toLowerCase();
}

/** The site's appearance for one page: its overrides over the site-wide settings. */
export function seoForPath(seo: Seo, p: string): Seo {
  const page = seo.pages?.[normalizeRoute(p)];
  return page ? { ...seo, ...Object.fromEntries(Object.entries(page).filter(([, v]) => v)) } : seo;
}

export class PublishBlocked extends Error {
  constructor(public readonly result: ChecksResult) {
    super("Publish blocked by failed checks");
    this.name = "PublishBlocked";
  }
}

export const STEPS = [
  { id: "checking", label: "Checking for changes" },
  { id: "building", label: "Building your app" },
  { id: "checks", label: "Running security and SEO checks" },
  { id: "applying", label: "Applying updates" },
  { id: "live", label: "Live" },
] as const;
export type StepId = (typeof STEPS)[number]["id"];

export function siteUrl(subdomain: string) {
  return siteOrigin(subdomain);
}

async function mainSha(projectId: string) {
  return git.resolveRef({ fs, dir: repoDir(projectId), ref: "main" });
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The accepted version's files, exported to .snapshots/<sha> next to the working tree.
 *
 * Builds and checks of main used to check main out in the working tree and switch back after.
 * The agent edits that same tree and the live preview serves it, so a publish, a preview link,
 * a shared link or the health monitor running during a build switched branches under the agent:
 * its edits landed on main or were overwritten, the preview showed main, and earlier work went
 * missing (Nov 2026). Now main is exported to its own folder and nothing switches branches.
 */
const exporting = new Map<string, Promise<string>>();
async function snapshotSource(projectId: string, sha: string) {
  const host = path.join(repoDir(projectId), ".snapshots", sha);
  if (await exists(path.join(host, "package.json"))) return `/app/.snapshots/${sha}`;
  const key = `${projectId}/${sha}`;
  if (!exporting.has(key)) {
    // Keep the export out of `git status` for good.
    const exclude = path.join(repoDir(projectId), ".git", "info", "exclude");
    const cur = await fs.readFile(exclude, "utf8").catch(() => "");
    if (!/^\/?\.snapshots\/?$/m.test(cur)) {
      await fs.mkdir(path.dirname(exclude), { recursive: true });
      await fs.writeFile(exclude, `${cur.replace(/\n?$/, "\n")}.snapshots/\n.builds/\n`);
    }
    exporting.set(key, exportTree(projectId, sha, host).then(() => host).finally(() => exporting.delete(key)));
  }
  await exporting.get(key);
  return `/app/.snapshots/${sha}`;
}

/** Production build of main into its snapshot directory, reusing one that exists. */
async function buildSnapshot(projectId: string, sha: string): Promise<{ ok: boolean; error?: string }> {
  const out = buildDir(projectId, sha);
  if (await exists(path.join(out, "index.html"))) return { ok: true };
  const state = await ensureSandbox(projectId);
  if (state.status !== "ready") {
    return { ok: false, error: state.status === "failed" ? state.error : "The build container is not running." };
  }
  const src = await snapshotSource(projectId, sha);
  const r = await sandboxExec(
    projectId,
    `cd ${src} && ${await mapsBuildEnv(projectId)}npx vite build --outDir /app/.builds/${sha} --emptyOutDir --logLevel error`,
    300_000,
  );
  if (r.code !== 0 || !(await exists(path.join(out, "index.html")))) {
    return { ok: false, error: r.out.trim().slice(-4000) || "The build failed." };
  }
  void pruneBuilds(projectId).catch(() => undefined);
  return { ok: true };
}

/** How many past builds to keep besides the live and current ones. */
const KEEP_BUILDS = 5;

/**
 * Older previews are cleaned up to save storage: keep the published build,
 * main's build and the newest few; a pruned version can be rebuilt on demand.
 */
export async function pruneBuilds(projectId: string) {
  const root = path.join(repoDir(projectId), ".builds");
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const p = await db.project.findUnique({ where: { id: projectId }, select: { publishedSha: true } });
  const keep = new Set([p?.publishedSha, await mainSha(projectId).catch(() => null)].filter(Boolean) as string[]);
  const dated = await Promise.all(
    names.map(async (n) => ({ n, t: (await fs.stat(path.join(root, n)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  dated.sort((a, b) => b.t - a.t);
  let kept = 0;
  for (const { n } of dated) {
    if (keep.has(n)) continue;
    if (kept < KEEP_BUILDS) {
      kept++;
      continue;
    }
    await fs.rm(path.join(root, n), { recursive: true, force: true });
  }
  // Exported sources: only main's is worth keeping (any other is re-exported if rebuilt).
  const snaps = path.join(repoDir(projectId), ".snapshots");
  for (const n of await fs.readdir(snaps).catch(() => [] as string[])) if (!keep.has(n) || n.includes(".part-")) await fs.rm(path.join(snaps, n), { recursive: true, force: true }).catch(() => undefined);
}

export async function versionBuilt(projectId: string, sha: string) {
  return exists(path.join(buildDir(projectId, sha), "index.html"));
}

/** Build a past version from its own exported copy (the working tree is never switched). */
export async function buildVersion(projectId: string, sha: string): Promise<{ ok: boolean; error?: string }> {
  if (await versionBuilt(projectId, sha)) return { ok: true };
  await git.readCommit({ fs, dir: repoDir(projectId), oid: sha });
  return buildSnapshot(projectId, sha);
}

const snapshotting = new Map<string, Promise<{ sha: string; ok: boolean; error?: string }>>();

/**
 * Build of the current accepted version (main), for preview links. Concurrent
 * callers for one project share a single build.
 */
export function ensureMainSnapshot(projectId: string) {
  const running = snapshotting.get(projectId);
  if (running) return running;
  const job = (async () => {
    const sha = await mainSha(projectId);
    if (await exists(path.join(buildDir(projectId, sha), "index.html"))) return { sha, ok: true };
    return { sha, ...(await buildSnapshot(projectId, sha)) };
  })().finally(() => snapshotting.delete(projectId));
  snapshotting.set(projectId, job);
  return job;
}

const SEVERITY_MAP: Record<Finding["severity"], CheckItem["severity"]> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
};

/**
 * TypeScript errors don't stop a Vite build, but some (an undefined name, a
 * missing property) crash the app as soon as it runs. Reported as a warning:
 * many generated apps run fine with minor type errors, so this never blocks.
 */
async function typeCheck(projectId: string, sha: string): Promise<Check> {
  const src = await snapshotSource(projectId, sha);
  const r = await sandboxExec(projectId, `cd ${src} && (npx tsc --noEmit -p tsconfig.app.json 2>/dev/null || npx tsc --noEmit)`, 180_000).catch(() => null);
  if (!r) return { id: "types", label: "Type check", status: "skipped", summary: "Couldn't run the type checker.", items: [] };
  const errors = r.out
    .split("\n")
    .map((l) => /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m);
  if (!errors.length) return { id: "types", label: "Type check", status: "passed", summary: "No type errors", items: [] };
  // "Cannot find name" and friends are the ones that crash at runtime.
  const crashy = errors.filter((m) => ["TS2304", "TS2552", "TS2339", "TS2307", "TS2349"].includes(m[3]));
  return {
    id: "types",
    label: "Type check",
    status: "warning",
    summary: `${errors.length} type error${errors.length === 1 ? "" : "s"}${crashy.length ? `, ${crashy.length} likely to break the app when it runs` : ""}`,
    items: (crashy.length ? crashy : errors).slice(0, 8).map((m) => ({ severity: crashy.includes(m) ? "high" : "low", title: m[4].slice(0, 200), detail: m[3], file: `${m[1]}:${m[2]}` })),
  };
}

async function securityCheck(projectId: string, sha: string): Promise<Check> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { securityConfig: true } });
  // Workspace rules add to the project's own: more checks off, and how severe a finding must be to block.
  const rules = await projectRules(projectId);
  const disabled = [...((p?.securityConfig as { disabled?: string[] } | null)?.disabled ?? []), ...rules.disabledChecks];
  const findings = [...(await scanProject(projectId, { disabled, ref: sha })), ...(await backendFindings(projectId))];
  // Findings the user ignored with a reason stay ignored across scans.
  const ignored = await db.securityFinding.findMany({
    where: { projectId, ignored: true },
    select: { rule: true, file: true },
  });
  const isIgnored = (f: Finding) => ignored.some((i) => i.rule === f.rule && i.file === f.file);

  await db.securityFinding.deleteMany({ where: { projectId, ignored: false } });
  const fresh = findings.filter((f) => !isIgnored(f));
  if (fresh.length) {
    await db.securityFinding.createMany({ data: fresh.map((f) => ({ ...f, projectId, sha })) });
  }
  const blocking = fresh.filter((f) => blocks(f.severity, rules.blockPublishOn));
  return {
    id: "security",
    label: "Security scan",
    status: blocking.length ? "failed" : fresh.length ? "warning" : "passed",
    summary: blocking.length
      ? `${blocking.length} issue${blocking.length === 1 ? "" : "s"} must be fixed before publishing`
      : fresh.length
        ? `${fresh.length} lower-severity finding${fresh.length === 1 ? "" : "s"}`
        : "No issues found",
    items: fresh.map((f) => ({
      severity: SEVERITY_MAP[f.severity],
      title: f.rule,
      detail: f.detail,
      file: `${f.file}:${f.line}`,
    })),
  };
}

type AuditJson = {
  vulnerabilities?: Record<string, { name: string; severity: string; via: unknown[]; fixAvailable?: unknown }>;
  metadata?: { vulnerabilities?: Record<string, number> };
};

async function dependencyCheck(projectId: string): Promise<Check> {
  const r = await sandboxExec(projectId, "npm audit --json --omit=dev 2>/dev/null || true", 120_000);
  let audit: AuditJson | null = null;
  try {
    audit = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    audit = null;
  }
  if (!audit?.metadata) {
    return { id: "dependencies", label: "Dependencies", status: "skipped", summary: "The audit could not run.", items: [] };
  }
  const vulns = Object.values(audit.vulnerabilities ?? {});
  const critical = vulns.filter((v) => v.severity === "critical").length;
  const high = vulns.filter((v) => v.severity === "high").length;
  return {
    id: "dependencies",
    label: "Dependencies",
    status: critical ? "failed" : high || vulns.length ? "warning" : "passed",
    summary: vulns.length
      ? `${vulns.length} vulnerable package${vulns.length === 1 ? "" : "s"}${critical ? ` (${critical} critical)` : ""}`
      : "No known vulnerabilities",
    items: vulns.map((v) => ({
      severity: (["critical", "high", "medium", "low"].includes(v.severity) ? v.severity : "info") as CheckItem["severity"],
      title: v.name,
      detail: v.fixAvailable ? "A fixed version is available." : "No fix available yet.",
    })),
  };
}

/** Static SEO review of what visitors and crawlers will actually receive. */
export async function seoCheck(projectId: string, sha: string, seo: Seo): Promise<Check> {
  const html = await fs.readFile(path.join(buildDir(projectId, sha), "index.html"), "utf8").catch(() => "");
  const items: CheckItem[] = [];
  const has = (re: RegExp) => re.test(html);
  const title = seo.title || /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || "";
  const description = seo.description || /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] || "";

  if (!title) items.push({ severity: "high", title: "Missing page title" });
  else if (title.length > 60) items.push({ severity: "low", title: "Title is longer than 60 characters", detail: title });
  if (!description || description === title)
    items.push({ severity: "medium", title: "Missing meta description", detail: "Search results show this under your title." });
  else if (description.length > 160) items.push({ severity: "low", title: "Description is longer than 160 characters" });
  if (!seo.ogImage && !has(/property="og:image"/i))
    items.push({ severity: "medium", title: "No social sharing image", detail: "Links shared on social media will have no preview image." });
  if (!seo.favicon && !has(/rel="(?:shortcut )?icon"/i)) items.push({ severity: "low", title: "No favicon" });
  if (!has(/<html[^>]+lang=/i)) items.push({ severity: "low", title: "Page language is not declared" });
  if (!has(/name="viewport"/i)) items.push({ severity: "high", title: "No mobile viewport tag" });

  // Images without alt text, in the source the app was built from.
  const files = await git.listFiles({ fs, dir: repoDir(projectId), ref: sha }).catch(() => [] as string[]);
  let missingAlt = 0;
  for (const f of files.filter((x) => /^src\/.*\.(tsx|jsx)$/.test(x))) {
    const src = await fs.readFile(path.join(repoDir(projectId), ".snapshots", sha, f), "utf8").catch(() => "");
    missingAlt += (src.match(/<img(?![^>]*\balt=)[^>]*>/g) ?? []).length;
  }
  if (missingAlt) items.push({ severity: "medium", title: `${missingAlt} image${missingAlt === 1 ? "" : "s"} without alt text` });

  const serious = items.filter((i) => i.severity === "high").length;
  return {
    id: "seo",
    label: "SEO review",
    status: serious ? "warning" : items.length ? "warning" : "passed",
    summary: items.length ? `${items.length} improvement${items.length === 1 ? "" : "s"} suggested` : "Looks good to search engines",
    items,
  };
}

/** Run every pre-publish check against main, recording the result. */
export async function runChecks(
  projectId: string,
  onStep?: (step: StepId) => void,
): Promise<ChecksResult> {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const seo = (project.seo as Seo | null) ?? {};

  {
    const sha = await mainSha(projectId);
    onStep?.("building");
    const built = await buildSnapshot(projectId, sha);
    const build: Check = {
      id: "build",
      label: "Build",
      status: built.ok ? "passed" : "failed",
      summary: built.ok ? "The app builds" : "The app does not build",
      items: built.ok ? [] : [{ severity: "critical", title: "Build failed", detail: built.error }],
    };

    onStep?.("checks");
    const [types, security, dependencies, seoResult] = await Promise.all([
      built.ok
        ? typeCheck(projectId, sha)
        : Promise.resolve<Check>({ id: "types", label: "Type check", status: "skipped", summary: "Skipped: the build failed.", items: [] }),
      securityCheck(projectId, sha),
      built.ok
        ? dependencyCheck(projectId)
        : Promise.resolve<Check>({ id: "dependencies", label: "Dependencies", status: "skipped", summary: "Skipped: the build failed.", items: [] }),
      built.ok
        ? seoCheck(projectId, sha, seo)
        : Promise.resolve<Check>({ id: "seo", label: "SEO review", status: "skipped", summary: "Skipped: the build failed.", items: [] }),
    ]);

    const checks = [build, types, security, dependencies, seoResult];
    const result: ChecksResult = {
      at: new Date().toISOString(),
      sha,
      checks,
      blocking: checks.some((c) => c.status === "failed"),
    };
    await db.project.update({ where: { id: projectId }, data: { lastChecks: result } });
    return result;
  }
}

/** Run the checks and, if nothing blocks, put main live. */
export async function publishProject(projectId: string, onStep?: (step: StepId) => void) {
  onStep?.("checking");
  const result = await runChecks(projectId, onStep);
  if (result.blocking) throw new PublishBlocked(result);

  onStep?.("applying");
  const project = await db.project.update({
    where: { id: projectId },
    data: { publishedSha: result.sha, publishedAt: new Date(), publishRequestedAt: null, publishRequestedById: null },
    select: { subdomain: true, publishedSha: true, publishedAt: true },
  });
  // The backend's Live environment: made on the first publish, schema brought up to date after.
  const live = await syncLive(projectId).catch((e) => ({ created: false, applied: [] as string[], failed: [{ id: "", error: String(e) }] }));
  // Accounts and records made in the preview go live with the version that uses them (adds only, never overwrites).
  const records: RecordsCopied = live.created || live.failed.length
    ? { tables: [], skipped: [] }
    : await copyNewRecords(projectId).catch((e) => ({ tables: [], skipped: [{ table: "", reason: String(e).slice(0, 300) }] }));
  // Server functions go live with the published version, not before.
  await deployIfChanged(projectId).catch(() => undefined);
  onStep?.("live");
  return { ...project, sha: result.sha, url: siteUrl(project.subdomain), checks: result, live, records };
}

export async function unpublish(projectId: string) {
  await db.project.update({
    where: { id: projectId },
    data: { publishedSha: null, publishedAt: null },
  });
}

/** Title and description the built page carries on its own, before overrides. */
async function pageDefaults(projectId: string, sha: string | null) {
  if (!sha) return { title: "", description: "" };
  const html = await fs.readFile(path.join(buildDir(projectId, sha), "index.html"), "utf8").catch(() => "");
  // These are shown as plain text in the dialog, so HTML entities are decoded.
  const decode = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return {
    title: decode(/<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ""),
    description: decode(/<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] ?? ""),
  };
}

/** What the publish button should say. */
export async function publishState(projectId: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const sha = await mainSha(projectId).catch(() => null);
  const head = await currentHead(projectId).catch(() => null);
  return {
    pageDefaults: await pageDefaults(projectId, project.publishedSha ?? sha),
    published: !!project.publishedSha,
    upToDate: !!project.publishedSha && project.publishedSha === sha,
    mainSha: sha,
    workingSha: head,
    publishedAt: project.publishedAt,
    url: project.publishedSha ? siteUrl(project.subdomain) : null,
    subdomain: project.subdomain,
    audience: project.publishAudience,
    showBadge: project.showBadge,
    seo: (project.seo as Seo | null) ?? {},
    lastChecks: (project.lastChecks as ChecksResult | null) ?? null,
    requestedAt: project.publishRequestedAt,
  };
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  webmanifest: "application/manifest+json",
};

/** Read one file of a published snapshot. Path traversal is refused. */
export async function readSiteFile(projectId: string, sha: string, rel: string) {
  const root = buildDir(projectId, sha);
  const target = path.resolve(root, `.${path.posix.normalize("/" + rel)}`);
  if (!target.startsWith(path.resolve(root))) return null;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return null;
    const ext = target.split(".").pop()?.toLowerCase() ?? "";
    return { bytes: await fs.readFile(target), type: TYPES[ext] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function upsertMeta(html: string, attr: "name" | "property", key: string, value: string) {
  const tag = `<meta ${attr}="${key}" content="${esc(value)}" />`;
  const re = new RegExp(`<meta\\s+${attr}="${key.replace(/[.:]/g, "\\$&")}"[^>]*>`, "i");
  return re.test(html) ? html.replace(re, tag) : html.replace("</head>", `    ${tag}\n  </head>`);
}

/** Apply the search/social settings and the badge to a published page. */
export function decorateHtml(html: string, seo: Seo, opts: { badge: boolean; editorUrl: string }) {
  let out = html;
  if (seo.title) {
    out = /<title>[^<]*<\/title>/i.test(out)
      ? out.replace(/<title>[^<]*<\/title>/i, `<title>${esc(seo.title)}</title>`)
      : out.replace("</head>", `<title>${esc(seo.title)}</title></head>`);
    out = upsertMeta(out, "property", "og:title", seo.title);
    out = upsertMeta(out, "name", "twitter:title", seo.title);
  }
  if (seo.description) {
    out = upsertMeta(out, "name", "description", seo.description);
    out = upsertMeta(out, "property", "og:description", seo.description);
    out = upsertMeta(out, "name", "twitter:description", seo.description);
  }
  if (seo.ogImage) {
    out = upsertMeta(out, "property", "og:image", seo.ogImage);
    out = upsertMeta(out, "name", "twitter:image", seo.ogImage);
    out = upsertMeta(out, "name", "twitter:card", "summary_large_image");
  }
  if (seo.favicon) {
    out = out.replace(/<link[^>]+rel="(?:shortcut )?icon"[^>]*>/gi, "");
    out = out.replace("</head>", `  <link rel="icon" href="${esc(seo.favicon)}" />\n  </head>`);
  }
  if (opts.badge) {
    out = out.replace(
      "</body>",
      `<a href="${esc(opts.editorUrl)}" target="_blank" rel="noopener" ` +
        `style="position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;align-items:center;gap:6px;` +
        `padding:6px 10px;border-radius:999px;background:#111;color:#fff;font:500 12px system-ui,sans-serif;` +
        `text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.2)">&#10022; Edit with ${esc(getBrand().name)}</a></body>`,
    );
  }
  return out;
}
