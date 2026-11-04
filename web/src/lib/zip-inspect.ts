import JSZip from "jszip";

/**
 * Look inside a ZIP before importing it (runs in the browser): how many
 * files, how big, what will be skipped, and what kind of project it is, so
 * the import can be confirmed or a different file chosen.
 */
export type ZipSummary = {
  files: number;
  bytes: number;
  skipped: number;
  framework: string;
  hasPackageJson: boolean;
  warnings: string[];
  top: string[];
};

const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|\.turbo|\.cache|coverage|__MACOSX)(\/|$)/;

export async function inspectZip(file: Blob, product = "IOTx"): Promise<ZipSummary> {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const names = entries.map((f) => f.name.replace(/\\/g, "/"));
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes("/")) ? `${[...tops][0]}/` : "";
  let bytes = 0;
  let files = 0;
  let skipped = 0;
  const kept: string[] = [];
  for (const f of entries) {
    const rel = f.name.replace(/\\/g, "/").slice(strip.length);
    if (!rel || SKIP.test(rel)) {
      skipped++;
      continue;
    }
    files++;
    kept.push(rel);
    bytes += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  const pkgEntry = entries.find((f) => f.name.replace(/\\/g, "/").slice(strip.length) === "package.json");
  let framework = "Unknown";
  const warnings: string[] = [];
  if (pkgEntry) {
    try {
      const pkg = JSON.parse(await pkgEntry.async("string")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      framework = deps.next ? "Next.js" : deps.vite && deps.react ? "Vite + React" : deps["react-scripts"] ? "Create React App" : deps.vue ? "Vue" : deps.svelte ? "Svelte" : deps.react ? "React" : "Node project";
      if (framework !== "Vite + React") warnings.push(`It looks like ${framework}. ${product} previews Vite + React apps; the agent can convert it after import.`);
    } catch {
      warnings.push("package.json couldn't be read.");
    }
  } else if (kept.some((n) => /\.html?$/i.test(n))) framework = "Static site";
  else warnings.push("No package.json found, so this may not be an app.");
  if (bytes > 60 * 1024 * 1024) warnings.push(`It's over 60 MB without dependencies, which is more than ${product} imports.`);
  if (files > 4000) warnings.push(`It has ${files} files; the limit is 4000.`);
  return { files, bytes, skipped, framework, hasPackageJson: !!pkgEntry, warnings, top: [...new Set(kept.map((n) => n.split("/")[0]))].slice(0, 12) };
}
