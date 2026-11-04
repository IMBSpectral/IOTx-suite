import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROJECTS_ROOT } from "./paths";

/**
 * Visual explanations: a self-contained SVG or HTML page the agent draws to
 * explain something (a flow, an architecture, a chart). Shown as a card in the
 * chat and served from a sandboxed route with no network access.
 */
export type Visual = { id: string; title: string; kind: "svg" | "html" | "doc"; createdAt: string };

const MAX_BYTES = 400_000;

function dir(projectId: string) {
  return path.join(PROJECTS_ROOT, "_visuals", projectId);
}

export class VisualError extends Error {}

export async function createVisual(projectId: string, title: string, body: string): Promise<Visual> {
  const trimmed = body.trim();
  if (!trimmed) throw new VisualError("The visual is empty.");
  if (Buffer.byteLength(trimmed) > MAX_BYTES) throw new VisualError("The visual is too large; keep it under 400 KB.");
  const kind: Visual["kind"] = /^<svg[\s>]/i.test(trimmed) ? "svg" : "html";
  if (kind === "html" && !/<(svg|div|table|canvas|body|html|section|main)[\s>]/i.test(trimmed)) {
    throw new VisualError("Send an <svg> element or an HTML document.");
  }
  const v: Visual = { id: randomUUID(), title: title.trim().slice(0, 120) || "Visual explanation", kind, createdAt: new Date().toISOString() };
  await fs.mkdir(dir(projectId), { recursive: true });
  await fs.writeFile(path.join(dir(projectId), `${v.id}.json`), JSON.stringify(v));
  await fs.writeFile(path.join(dir(projectId), `${v.id}.${kind}`), trimmed);
  return v;
}

/** A document the agent wrote (Markdown): plans, specs, reports. Shown as a card and in Artifacts. */
export async function createDocument(projectId: string, title: string, markdown: string): Promise<Visual> {
  const body = markdown.trim();
  if (!body) throw new VisualError("The document is empty.");
  if (Buffer.byteLength(body) > MAX_BYTES) throw new VisualError("The document is too large; keep it under 400 KB.");
  const v: Visual = { id: randomUUID(), title: title.trim().slice(0, 120) || "Document", kind: "doc", createdAt: new Date().toISOString() };
  await fs.mkdir(dir(projectId), { recursive: true });
  await fs.writeFile(path.join(dir(projectId), `${v.id}.json`), JSON.stringify(v));
  await fs.writeFile(path.join(dir(projectId), `${v.id}.doc`), body);
  return v;
}

/** Everything the agent made for this project, newest first (the Artifacts panel). */
export async function listArtifacts(projectId: string): Promise<Visual[]> {
  const names = await fs.readdir(dir(projectId)).catch(() => [] as string[]);
  const out: Visual[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir(projectId), n), "utf8")) as Visual);
    } catch {
      // skip a damaged record
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readVisual(projectId: string, id: string): Promise<{ visual: Visual; body: string } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    const visual = JSON.parse(await fs.readFile(path.join(dir(projectId), `${id}.json`), "utf8")) as Visual;
    const body = await fs.readFile(path.join(dir(projectId), `${id}.${visual.kind}`), "utf8");
    return { visual, body };
  } catch {
    return null;
  }
}

/** Wrap the visual in a page that fits it to the card and follows the editor's theme. */
export function visualPage(v: Visual, body: string, theme: "light" | "dark") {
  if (v.kind === "html" && /<html[\s>]/i.test(body)) return body;
  // Documents render in the app as Markdown; served directly they're plain text.
  if (v.kind === "doc") body = `<pre style="white-space:pre-wrap;font:inherit">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
  const bg = theme === "dark" ? "#17171a" : "#ffffff";
  const fg = theme === "dark" ? "#ececf1" : "#18181b";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:${bg};color:${fg};font:14px/1.5 system-ui,sans-serif}body{padding:16px;box-sizing:border-box}
svg{max-width:100%;height:auto;display:block;margin:0 auto}</style></head><body>${body}</body></html>`;
}
