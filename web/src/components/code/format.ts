import type { Plugin } from "prettier";

/**
 * "Format document" with Prettier's standalone build. Prettier and only the
 * plugins a file type needs load on first use, in the browser.
 */
type Spec = { parser: string; plugins: () => Promise<unknown>[] };

const estree = () => import("prettier/plugins/estree");
const babel = () => import("prettier/plugins/babel");
const SPECS: Record<string, Spec> = {
  ts: { parser: "typescript", plugins: () => [import("prettier/plugins/typescript"), estree()] },
  tsx: { parser: "typescript", plugins: () => [import("prettier/plugins/typescript"), estree()] },
  mts: { parser: "typescript", plugins: () => [import("prettier/plugins/typescript"), estree()] },
  js: { parser: "babel", plugins: () => [babel(), estree()] },
  jsx: { parser: "babel", plugins: () => [babel(), estree()] },
  mjs: { parser: "babel", plugins: () => [babel(), estree()] },
  cjs: { parser: "babel", plugins: () => [babel(), estree()] },
  json: { parser: "json", plugins: () => [babel(), estree()] },
  css: { parser: "css", plugins: () => [import("prettier/plugins/postcss")] },
  // HTML formats its inline <style> and <script> too.
  html: { parser: "html", plugins: () => [import("prettier/plugins/html"), import("prettier/plugins/postcss"), babel(), estree()] },
  md: { parser: "markdown", plugins: () => [import("prettier/plugins/markdown")] },
};

const ext = (path: string) => (path.includes(".") ? path.split(".").pop()!.toLowerCase() : "");

export function canFormat(path: string) {
  return ext(path) in SPECS;
}

/** The formatted text and where the cursor lands in it. Throws on a syntax error. */
export async function formatCode(path: string, text: string, cursorOffset = 0): Promise<{ formatted: string; cursorOffset: number }> {
  const spec = SPECS[ext(path)];
  if (!spec) throw new Error("This file type can't be formatted.");
  const [prettier, ...mods] = await Promise.all([import("prettier/standalone"), ...spec.plugins()]);
  const plugins = mods.map((m) => ((m as { default?: Plugin }).default ?? m) as Plugin);
  return prettier.formatWithCursor(text, {
    parser: spec.parser,
    plugins,
    filepath: path,
    cursorOffset: Math.min(Math.max(0, cursorOffset), text.length),
  });
}
