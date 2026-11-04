import JSZip from "jszip";

/**
 * Zipped folders attached to a message ("Codebase" / "Zipped folder"): list
 * and read what's inside, or bring the files into the project. Build output,
 * dependencies, VCS folders and secrets files are left out, and a single
 * top-level folder (the usual "my-app/…" wrapper) is dropped.
 */
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|\.turbo|\.cache|coverage|__MACOSX)(\/|$)|(^|\/)\.DS_Store$|(^|\/)\.env(\.[\w.-]+)?$/;
export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 2_000_000;
export const MAX_TOTAL_BYTES = 30_000_000;

export class ArchiveError extends Error {}

export type ArchiveEntry = { path: string; size: number; file: JSZip.JSZipObject };

export async function openArchive(bytes: Buffer): Promise<ArchiveEntry[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ArchiveError("That attachment isn't a readable .zip file.");
  }
  const files = Object.values(zip.files).filter((f) => !f.dir);
  const names = files.map((f) => f.name.replace(/\\/g, "/"));
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes("/")) ? `${[...tops][0]}/` : "";
  const out: ArchiveEntry[] = [];
  for (const f of files) {
    const rel = f.name.replace(/\\/g, "/").slice(strip.length);
    if (!rel || SKIP.test(rel) || rel.split("/").includes("..") || rel.startsWith("/")) continue;
    // Uncompressed size from the zip's own header; checked again after reading.
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    out.push({ path: rel, size, file: f });
  }
  if (out.length > MAX_FILES) throw new ArchiveError(`The archive has ${out.length} files; the limit is ${MAX_FILES}.`);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const TEXT = /\.(tsx?|jsx?|mjs|cjs|json|css|scss|html?|md|mdx|txt|ya?ml|toml|svg|sql|py|rb|go|rs|java|kt|swift|vue|svelte|astro|env\.example|gitignore|prettierrc|eslintrc)$|(^|\/)(Dockerfile|Makefile|README|LICENSE)$/i;
export const isText = (p: string) => TEXT.test(p);

export function listing(entries: ArchiveEntry[]) {
  const total = entries.reduce((n, e) => n + e.size, 0);
  const lines = entries.slice(0, 400).map((e) => `${e.path} (${e.size} B)`);
  if (entries.length > 400) lines.push(`… and ${entries.length - 400} more`);
  return `${entries.length} files, ${total} bytes:\n${lines.join("\n")}`;
}

export async function readEntry(entries: ArchiveEntry[], p: string) {
  const e = entries.find((x) => x.path === p.replace(/^\.?\//, ""));
  if (!e) throw new ArchiveError(`No file ${p} in the archive.`);
  if (!isText(e.path)) throw new ArchiveError(`${p} isn't a text file; import it instead of reading it.`);
  const text = await e.file.async("string");
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated)` : text;
}

/** Every importable file's bytes, within the size limits. */
export async function extractAll(entries: ArchiveEntry[], under = "") {
  const prefix = under.replace(/^\/+|\/+$/g, "");
  const out: { path: string; bytes: Buffer }[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const e of entries) {
    const bytes = await e.file.async("nodebuffer");
    if (bytes.length > MAX_FILE_BYTES) {
      skipped.push(`${e.path} (over 2 MB)`);
      continue;
    }
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new ArchiveError("The archive is over 30 MB once unpacked.");
    out.push({ path: prefix ? `${prefix}/${e.path}` : e.path, bytes });
  }
  return { files: out, skipped };
}
