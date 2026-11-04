import fs from "node:fs/promises";
import path from "node:path";

/**
 * Structural guarantees the app must satisfy regardless of what the model
 * wrote.
 *
 * These are not style preferences — they are things that silently destroy the
 * app when missing. The stylesheet import is the clearest case: the model
 * rewrites `main.tsx`, drops `import "./index.css"`, and every Tailwind class
 * in the project becomes inert. Nothing errors, nothing fails to compile, and
 * the page renders as unstyled HTML. A prompt instruction is not sufficient
 * for an invariant this cheap to check and this catastrophic to miss.
 */

export type Repair = { file: string; note: string };

const ENTRYPOINTS = ["src/main.tsx", "src/main.ts", "src/index.tsx"];
const STYLESHEETS = ["src/index.css", "src/main.css", "src/styles.css"];

const IMPORT_LINE = /^\s*import\s+(?:[^"']*from\s*)?["']([^"']+)["']/;

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function firstPresent(dir: string, candidates: string[]) {
  for (const c of candidates) {
    if (await exists(path.join(dir, c))) return c;
  }
  return null;
}

/** Ensure the entrypoint imports the project's stylesheet. */
async function ensureStylesheetImported(dir: string): Promise<Repair | null> {
  const entry = await firstPresent(dir, ENTRYPOINTS);
  if (!entry) return null;

  const sheet = await firstPresent(dir, STYLESHEETS);
  if (!sheet) return null;

  const entryPath = path.join(dir, entry);
  const source = await fs.readFile(entryPath, "utf8");
  const base = path.basename(sheet);
  const lines = source.split("\n");

  // Compare the resolved specifier rather than matching a pattern built from
  // a filename: escaping a path into a regex is easy to get subtly wrong, and
  // a false negative appends a duplicate import on every single build.
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IMPORT_LINE);
    if (!m) continue;
    lastImport = i;
    if (path.basename(m[1]) === base) return null;
  }

  const stmt = 'import "./' + base + '";';
  lines.splice(lastImport + 1, 0, stmt);
  await fs.writeFile(entryPath, lines.join("\n"), "utf8");

  return { file: entry, note: "added " + stmt + " — without it no styles are applied" };
}

/**
 * Apply every invariant, returning what had to be repaired so the build can
 * report it rather than fixing things behind the user's back.
 */
export async function enforceInvariants(dir: string): Promise<Repair[]> {
  const repairs: Repair[] = [];
  const sheet = await ensureStylesheetImported(dir);
  if (sheet) repairs.push(sheet);
  return repairs;
}
