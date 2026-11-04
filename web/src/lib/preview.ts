import { build as esbuild } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { repoDir } from "./paths";
import { INSPECTOR_SCRIPT } from "./inspector";
import { MONITOR_SCRIPT } from "./preview-monitor";

/**
 * Preview tokens authorize access to one project's generated bundle, and
 * nothing else. They are deliberately independent of the user's session so
 * the preview origin never needs the session cookie.
 */
const TOKEN_TTL = "24h";

function secret() {
  const s = process.env.PREVIEW_TOKEN_SECRET;
  if (!s) throw new Error("PREVIEW_TOKEN_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function signPreviewToken(projectId: string, userId: string) {
  return new SignJWT({ user_id: userId, project_id: projectId, access_type: "project" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(projectId)
    .setAudience("preview")
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret());
}

export async function verifyPreviewToken(token: string, projectId: string) {
  const { payload } = await jwtVerify(token, secret(), { audience: "preview" });
  if (payload.project_id !== projectId) throw new Error("Token/project mismatch");
  return payload;
}

/** URL the editor points its preview frame at. */
export async function previewUrl(projectId: string, userId: string, sha: string) {
  const token = await signPreviewToken(projectId, userId);
  const base = process.env.PREVIEW_ORIGIN;
  const qs = `?token=${encodeURIComponent(token)}&sha=${encodeURIComponent(sha)}`;
  // A dedicated origin per project is what keeps generated code away from the
  // app's cookies. Falls back to a same-origin route only for local dev.
  return base
    ? `${base.replace("{id}", projectId)}/${qs}`
    : `/api/preview/${projectId}${qs}`;
}

const HTML_SHELL = (js: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.tailwindcss.com/3.4.17"></script>
<style>body{margin:0}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${js}</script>
<script>${MONITOR_SCRIPT}</script>
<script>${INSPECTOR_SCRIPT}</script>
</body>
</html>`;

const ERROR_SHELL = (msg: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body{margin:0;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;
       background:#1c1917;color:#fca5a5;padding:24px;line-height:1.6}
  h1{font:600 13px ui-sans-serif,system-ui;color:#fafaf9;
     text-transform:uppercase;letter-spacing:.08em;margin:0 0 12px}
  pre{white-space:pre-wrap;word-break:break-word;margin:0}
</style></head>
<body><h1>Build failed</h1><pre>${msg
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")}</pre></body></html>`;

/**
 * Bundle a project into a single self-contained HTML document.
 *
 * React is pulled from a CDN via an import map rather than installed per
 * project, so a build is a single esbuild pass with no npm install.
 */
export async function bundleProject(projectId: string): Promise<{
  html: string;
  sha: string;
  ok: boolean;
  error?: string;
}> {
  const dir = repoDir(projectId);
  const entry = path.join(dir, "src", "main.tsx");

  try {
    await fs.access(entry);
  } catch {
    const missing = "src/main.tsx not found. The project has no entry point.";
    return { html: ERROR_SHELL(missing), sha: "none", ok: false, error: missing };
  }

  try {
    const result = await esbuild({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      target: "es2020",
      jsx: "automatic",
      absWorkingDir: dir,
      logLevel: "silent",
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
      define: { "process.env.NODE_ENV": '"production"' },
    });

    const js = result.outputFiles[0].text;
    const importMap = `
<script type="importmap">
{"imports":{
  "react":"https://esm.sh/react@18.3.1",
  "react-dom":"https://esm.sh/react-dom@18.3.1",
  "react-dom/client":"https://esm.sh/react-dom@18.3.1/client",
  "react/jsx-runtime":"https://esm.sh/react@18.3.1/jsx-runtime"
}}
</script>`;
    const html = HTML_SHELL(js).replace("<div id=\"root\">", `${importMap}<div id="root">`);
    const sha = crypto.createHash("sha256").update(html).digest("hex").slice(0, 12);
    return { html, sha, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { html: ERROR_SHELL(msg), sha: "error", ok: false, error: msg };
  }
}
