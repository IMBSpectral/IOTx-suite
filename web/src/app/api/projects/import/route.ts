import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import JSZip from "jszip";
import { requireUser, currentWorkspace } from "@/lib/workspace";
import { requirePerm } from "@/lib/iotx/permissions";
import { createProject } from "@/lib/create-project";
import { route } from "@/lib/route";
import { githubToken } from "@/lib/connectors";
import { assertPublicUrl, publicFetch } from "@/lib/net";

export const maxDuration = 300;

/**
 * Import a project: a public GitHub/GitLab repository, a ZIP, or an existing
 * website (only what visitors can see is read; it becomes a brief the agent
 * rebuilds from).
 */

const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|\.vercel|\.turbo|coverage)(\/|$)/;
const MAX_FILES = 4000;
const MAX_TOTAL = 60 * 1024 * 1024;

type ImportedFile = { path: string; bytes: Buffer };

function keep(files: ImportedFile[]) {
  const out = files.filter((f) => !SKIP.test(f.path) && !f.path.endsWith("/"));
  if (out.length > MAX_FILES) throw new Error(`That has ${out.length} files; the limit is ${MAX_FILES}.`);
  const total = out.reduce((n, f) => n + f.bytes.length, 0);
  if (total > MAX_TOTAL) throw new Error("That project is larger than 60 MB once dependencies are excluded.");
  if (!out.some((f) => f.path === ".gitignore")) {
    out.push({ path: ".gitignore", bytes: Buffer.from("node_modules\ndist\n.builds\n.env\n") });
  }
  return out;
}

/** Strip a single wrapping folder, as GitHub's "Download ZIP" adds. */
function unwrap(files: ImportedFile[]) {
  const tops = new Set(files.map((f) => f.path.split("/")[0]));
  if (tops.size !== 1 || !files.every((f) => f.path.includes("/"))) return files;
  const [top] = tops;
  // A lone source folder is part of the project, not a wrapper.
  if (/^(src|app|public|lib|components|pages)$/.test(top)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) })).filter((f) => f.path);
}

async function fromZip(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const files: ImportedFile[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || SKIP.test(entry.name) || entry.name.includes("..")) continue;
    files.push({ path: entry.name, bytes: await entry.async("nodebuffer") });
    if (files.length > MAX_FILES * 2) break;
  }
  return keep(unwrap(files));
}

/**
 * Clone a repository (shallow). Private repositories need a token: the one
 * pasted for this import (used once, never stored) or the workspace's GitHub
 * connector.
 */
async function fromGit(repoUrl: string, token?: string | null) {
  const u = new URL(repoUrl);
  if (!["github.com", "gitlab.com"].includes(u.hostname)) throw new Error("Use a github.com or gitlab.com repository URL.");
  const [owner, repo] = u.pathname.replace(/^\/|\.git$/g, "").split("/");
  if (!owner || !repo) throw new Error("That doesn't look like a repository URL.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-import-"));
  try {
    await git.clone({
      fs,
      http,
      dir,
      url: `https://${u.hostname}/${owner}/${repo}.git`,
      depth: 1,
      singleBranch: true,
      ...(token
        ? { onAuth: () => (u.hostname === "gitlab.com" ? { username: "oauth2", password: token } : { username: "x-access-token", password: token }) }
        : {}),
    });
    const files: ImportedFile[] = [];
    for (const rel of await git.listFiles({ fs, dir })) {
      if (SKIP.test(rel)) continue;
      files.push({ path: rel, bytes: await fs.readFile(path.join(dir, rel)) });
    }
    return { name: repo, files: keep(files) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const text = (s: string) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function fromWebsite(raw: string) {
  const u = await assertPublicUrl(raw);
  const res = await publicFetch(u, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "ForgeImporter/1.0 (+site rebuild)" },
  });
  if (!res.ok) throw new Error(`The site answered with HTTP ${res.status}.`);
  const html = (await res.text()).slice(0, 2_000_000);
  const title = text(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") || u.hostname;
  const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i.exec(html)?.[1] ?? "";
  const body = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ");
  const headings = [...body.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => `${"#".repeat(+m[1])} ${text(m[2])}`).filter((h) => h.length > 3).slice(0, 40);
  const nav = [...new Set([...body.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => text(m[1])).filter((t) => t && t.length < 30))].slice(0, 15);
  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => text(m[1])).filter((t) => t.length > 40).slice(0, 25);
  const colors = [...new Set((html.match(/#[0-9a-f]{6}\b/gi) ?? []).map((c) => c.toLowerCase()))].slice(0, 8);

  const brief =
    `Recreate the website at ${u.href} as a new app. Keep its structure, sections and content; ` +
    `improve the design where it helps. Only what visitors can see was read — logins, databases and other ` +
    `backends are not included.\n\nTitle: ${title}\n${description ? `Description: ${description}\n` : ""}` +
    `${nav.length ? `Navigation: ${nav.join(" · ")}\n` : ""}${colors.length ? `Colours used: ${colors.join(", ")}\n` : ""}` +
    `\nPage outline:\n${headings.join("\n")}\n\nKey copy:\n${paragraphs.map((p) => `- ${p.slice(0, 300)}`).join("\n")}`;
  return { name: title.slice(0, 60), brief: brief.slice(0, 12_000) };
}

async function POST_(req: Request) {
  const user = await requireUser();
  const ws = await currentWorkspace(user.id);
  await requirePerm(user.id, ws.id, "builder.project.create");

  try {
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({ error: "Choose a ZIP file." }, { status: 400 });
      if (file.size > 100 * 1024 * 1024) return Response.json({ error: "ZIP files can be up to 100 MB." }, { status: 413 });
      const files = await fromZip(Buffer.from(await file.arrayBuffer()));
      if (files.length < 2) return Response.json({ error: "That ZIP doesn't contain a project." }, { status: 400 });
      const project = await createProject({
        workspaceId: ws.id,
        userId: user.id,
        name: file.name.replace(/\.zip$/i, ""),
        files,
        message: `Import ${file.name}`,
      });
      return Response.json({ project, files: files.length }, { status: 201 });
    }

    const { source, url, token } = (await req.json()) as { source?: string; url?: string; token?: string };
    if (!url) return Response.json({ error: "Enter a URL." }, { status: 400 });

    if (source === "github") {
      const auth = token?.trim() || (new URL(url).hostname === "github.com" ? await githubToken(ws.id) : null);
      const { name, files } = await fromGit(url, auth).catch((e: unknown) => {
        // Git answers 401/404 alike for private repos it can't see.
        const msg = e instanceof Error ? e.message : "";
        if (/401|403|404|not found|authentication/i.test(msg)) {
          throw new Error(
            auth
              ? "Couldn't read that repository with the token. Check the URL and that the token can read it."
              : "That repository is private or doesn't exist. Connect GitHub (Settings → Connectors) or paste a token with read access.",
          );
        }
        throw e;
      });
      const project = await createProject({ workspaceId: ws.id, userId: user.id, name, files, message: `Import ${url}` });
      return Response.json({ project, files: files.length }, { status: 201 });
    }
    if (source === "website") {
      const { name, brief } = await fromWebsite(url);
      const project = await createProject({ workspaceId: ws.id, userId: user.id, name: `${name} (rebuild)` });
      return Response.json({ project, seed: brief }, { status: 201 });
    }
    return Response.json({ error: "Unknown import source" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Import failed" }, { status: 400 });
  }
}

export const POST = route(POST_);
