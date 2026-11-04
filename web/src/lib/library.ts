import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT, repoDir } from "./paths";
import { listFiles, safeRelPath } from "./repo";
import { readUpload, type Attachment } from "./uploads";

/**
 * The project's files library: media and documents in the project (images,
 * video, PDFs, Markdown) and files attached in chat. Items are addressed by a
 * key, "project:<path>" or "upload:<id>", so both kinds share one surface.
 * Collections group items and live beside the uploads, not in the app.
 */

export type Kind = "image" | "video" | "document" | "other";
export type LibraryItem = {
  key: string;
  name: string;
  path: string | null;
  kind: Kind;
  type: string;
  size: number;
  modifiedAt: string;
  source: "project" | "upload";
};
export type Collection = { id: string; name: string; items: string[] };

export const MAX_PER_COLLECTION = 500;
export const MAX_COLLECTIONS = 100;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  pdf: "application/pdf", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

const ext = (p: string) => p.split(".").pop()?.toLowerCase() ?? "";

function kindOf(type: string): Kind {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf" || type.startsWith("text/") || type.includes("word") || type.includes("sheet")) return "document";
  return "other";
}

/** Project files that count as library items rather than code. */
function isLibraryFile(p: string) {
  const e = ext(p);
  if (!(e in TYPES)) return false;
  // Documents count wherever they are; media only in asset folders.
  if (e === "md" || e === "txt" || e === "csv") return !p.startsWith("node_modules/");
  return p.startsWith("public/") || p.startsWith("src/assets/") || p.startsWith("docs/") || p.startsWith("assets/");
}

const uploadsDir = (projectId: string) => path.join(PROJECTS_ROOT, "_uploads", projectId);

export async function listLibrary(projectId: string): Promise<LibraryItem[]> {
  const dir = repoDir(projectId);
  const items: LibraryItem[] = [];
  for (const p of (await listFiles(projectId)).filter(isLibraryFile)) {
    const st = await fs.stat(path.join(dir, p)).catch(() => null);
    if (!st) continue;
    const type = TYPES[ext(p)];
    items.push({
      key: `project:${p}`,
      name: path.basename(p),
      path: p,
      kind: kindOf(type),
      type,
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      source: "project",
    });
  }
  const metas = (await fs.readdir(uploadsDir(projectId)).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  for (const f of metas) {
    const meta = JSON.parse(await fs.readFile(path.join(uploadsDir(projectId), f), "utf8").catch(() => "null")) as Attachment | null;
    if (!meta) continue;
    const st = await fs.stat(path.join(uploadsDir(projectId), `${meta.id}.bin`)).catch(() => null);
    items.push({
      key: `upload:${meta.id}`,
      name: meta.name,
      path: null,
      kind: kindOf(meta.type),
      type: meta.type,
      size: meta.size,
      modifiedAt: (st?.mtime ?? new Date()).toISOString(),
      source: "upload",
    });
  }
  return items;
}

/** Bytes and type for one item; null for anything outside this project. */
export async function readLibraryItem(projectId: string, key: string) {
  if (key.startsWith("upload:")) {
    const u = await readUpload(projectId, key.slice("upload:".length));
    return u ? { bytes: u.bytes, type: u.meta.type, name: u.meta.name } : null;
  }
  if (key.startsWith("project:")) {
    let rel: string;
    try {
      rel = safeRelPath(key.slice("project:".length));
    } catch {
      return null;
    }
    if (!isLibraryFile(rel)) return null;
    const bytes = await fs.readFile(path.join(repoDir(projectId), rel)).catch(() => null);
    return bytes ? { bytes, type: TYPES[ext(rel)], name: path.basename(rel) } : null;
  }
  return null;
}

const collectionsFile = (projectId: string) => path.join(PROJECTS_ROOT, "_library", `${projectId}.json`);

export async function getCollections(projectId: string): Promise<Collection[]> {
  const raw = await fs.readFile(collectionsFile(projectId), "utf8").catch(() => "[]");
  return JSON.parse(raw) as Collection[];
}

async function saveCollections(projectId: string, list: Collection[]) {
  await fs.mkdir(path.dirname(collectionsFile(projectId)), { recursive: true });
  await fs.writeFile(collectionsFile(projectId), JSON.stringify(list));
}

export class LibraryError extends Error {}

/** Create, rename, delete, add to and remove from collections. */
export async function updateCollections(
  projectId: string,
  op:
    | { action: "create"; name: string }
    | { action: "rename"; id: string; name: string }
    | { action: "delete"; id: string }
    | { action: "add" | "remove"; id: string; keys: string[] },
) {
  const list = await getCollections(projectId);
  const find = (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c) throw new LibraryError("Collection not found");
    return c;
  };
  const cleanName = (n: string) => {
    const name = n.trim().slice(0, 60);
    if (!name) throw new LibraryError("Give the collection a name.");
    return name;
  };
  switch (op.action) {
    case "create":
      if (list.length >= MAX_COLLECTIONS) throw new LibraryError(`A project can have up to ${MAX_COLLECTIONS} collections.`);
      list.push({ id: crypto.randomUUID(), name: cleanName(op.name), items: [] });
      break;
    case "rename":
      find(op.id).name = cleanName(op.name);
      break;
    case "delete":
      list.splice(list.indexOf(find(op.id)), 1);
      break;
    case "add": {
      const c = find(op.id);
      const next = [...new Set([...c.items, ...op.keys.filter((k) => /^(project|upload):/.test(k))])];
      if (next.length > MAX_PER_COLLECTION) throw new LibraryError(`A collection holds up to ${MAX_PER_COLLECTION} files.`);
      c.items = next;
      break;
    }
    case "remove": {
      const c = find(op.id);
      c.items = c.items.filter((k) => !op.keys.includes(k));
      break;
    }
  }
  await saveCollections(projectId, list);
  return list;
}
