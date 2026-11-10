/**
 * Insights: a file people add becomes tables (for SQL and charts) and text (for the AI to read).
 *
 * - Excel: every sheet, headings found below any title rows, dates as dates.
 * - CSV / TSV, JSON, Parquet: read by DuckDB directly.
 * - Word and PowerPoint: their text, and every table in them as a table.
 * - PDF: its text, page by page (the AI can turn a table it finds there into a table).
 * - Markdown / text / HTML: the text, and Markdown or HTML tables as tables.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { readWorkbook, headerRow } from "../spreadsheet";
import { docxText, pptxText, pdfPages } from "../uploads";
import { cleanHeadings, freeName, loadFile, loadRows, rowCount } from "./engine";
import { docFile, InsightsError, sourceFile, type Analysis, type Source } from "./store";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const DOC_TEXT_MAX = 2_000_000;

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const baseName = (name: string) => name.replace(/\.[^.]+$/, "");

/** Word tables (<w:tbl>), as rows of cell text. */
async function docxTables(bytes: Buffer) {
  const xml = (await (await JSZip.loadAsync(bytes)).file("word/document.xml")?.async("string")) ?? "";
  return [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((t) =>
    [...t[1].matchAll(/<w:tr[\s>]([\s\S]*?)<\/w:tr>/g)].map((r) =>
      [...r[1].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) =>
        xmlText([...c[1].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(" ")).replace(/\s+/g, " ").trim(),
      ),
    ),
  );
}

/** PowerPoint tables (<a:tbl>) on every slide. */
async function pptxTables(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  const out: { slide: number; rows: string[][] }[] = [];
  for (const f of slides) {
    const xml = (await zip.file(f)?.async("string")) ?? "";
    for (const t of xml.matchAll(/<a:tbl>([\s\S]*?)<\/a:tbl>/g))
      out.push({
        slide: Number(/(\d+)\.xml$/.exec(f)![1]),
        rows: [...t[1].matchAll(/<a:tr[\s>]([\s\S]*?)<\/a:tr>/g)].map((r) =>
          [...r[1].matchAll(/<a:tc[\s>]([\s\S]*?)<\/a:tc>/g)].map((c) => xmlText([...c[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" ")).trim()),
        ),
      });
  }
  return out.sort((a, b) => a.slide - b.slide);
}

/** Markdown pipe tables. */
function markdownTables(text: string) {
  const out: string[][][] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) continue;
    const rows: string[][] = [];
    const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    rows.push(cells(lines[i]));
    let j = i + 2;
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) rows.push(cells(lines[j]));
    out.push(rows);
    i = j;
  }
  return out;
}

/** HTML tables, roughly (cell text only). */
function htmlTables(html: string) {
  const strip = (s: string) => xmlText(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return [...html.matchAll(/<table[\s>]([\s\S]*?)<\/table>/gi)].map((t) =>
    [...t[1].matchAll(/<tr[\s>]([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => strip(c[1]))),
  );
}

type Grid = { headings: string[]; body: string[][]; title?: string };

/**
 * Rows of text (a sheet or a document table) ready to load: blank rows dropped, the heading
 * row found below any title rows, and columns with no data dropped (a stray cell far to the
 * right otherwise makes a sheet thousands of columns wide).
 */
function prepareGrid(grid: string[][], dropEmpty = true): Grid | null {
  const rows = grid.filter((r) => r.some((c) => c && c.trim()));
  if (rows.length < 2) return null;
  const h = headerRow(rows);
  const body0 = rows.slice(h + 1);
  if (!body0.length) return null;
  // Columns with a heading or any data, up to the last one used (a stray far-right cell is ignored by dropEmptyColumns).
  const width = Math.min(Math.max(...rows.slice(h).map((r) => r.length)), 20_000);
  const used: number[] = [];
  for (let i = 0; i < width; i++) if ((rows[h][i] && rows[h][i].trim()) || body0.some((r) => r[i] && r[i].trim())) used.push(i);
  if (!used.length) return null;
  const g = {
    headings: used.map((i) => (rows[h][i] ?? "").replace(/\s+/g, " ").trim()),
    body: body0.map((r) => used.map((i) => (r[i] ?? "").trim())),
    title: h > 0 ? rows.slice(0, h).map((r) => r.filter(Boolean).join(" ")).join(" / ").slice(0, 300) : undefined,
  };
  return dropEmpty ? dropEmptyColumns(g) : g;
}

/** Keep only columns with data (at most 1000), with clean unique headings. */
function dropEmptyColumns(g: Grid): Grid | null {
  const keep: number[] = [];
  for (let i = 0; i < g.headings.length && keep.length < 1000; i++) if (g.body.some((r) => r[i])) keep.push(i);
  if (!keep.length) return null;
  return { headings: cleanHeadings(keep.map((i) => g.headings[i]), keep.length), body: g.body.map((r) => keep.map((i) => r[i] ?? "")), title: g.title };
}

async function loadGrid(a: Analysis, src: Source, want: string, g: Grid, part?: string) {
  const name = freeName(a, want);
  const columns = await loadRows(a, name, g.headings, g.body);
  a.tables.push({ name, source: src.name, part, rows: g.body.length, columns, title: g.title });
  src.tables.push(name);
  return name;
}

async function addGrid(a: Analysis, src: Source, want: string, grid: string[][], part?: string) {
  const g = prepareGrid(grid);
  return g ? loadGrid(a, src, want, g, part) : null;
}

/**
 * Sheets of one workbook with the same headings (a sheet per day, month or branch) become
 * one table with a "Sheet" column (and "Sheet title" when their titles differ), so the data
 * can be compared across them in one query.
 */
async function addWorkbook(a: Analysis, src: Source, stem: string, sheets: { name: string; hidden: boolean; rows: string[][] }[]) {
  // Grouped by their headings as written (before empty columns are dropped: a day with a blank column still matches).
  const prepared = sheets.map((s) => ({ s, g: prepareGrid(s.rows, false) })).filter((x): x is { s: (typeof sheets)[number]; g: Grid } => !!x.g);
  const groups = new Map<string, typeof prepared>();
  for (const p of prepared) {
    const named = p.g.headings.filter(Boolean);
    const key = named.length >= 3 ? named.join("\u0001").toLowerCase() : `single:${p.s.name}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      const { s } = group[0];
      const g = dropEmptyColumns(group[0].g);
      if (g) await loadGrid(a, src, prepared.length === 1 ? stem : s.name, g, `sheet "${s.name}"${s.hidden ? " (hidden)" : ""}`);
      continue;
    }
    // Line the sheets up by heading name (their blank-heading columns may sit in different places).
    const names = group[0].g.headings.filter(Boolean);
    const titles = new Set(group.map((p) => p.g.title ?? ""));
    const withTitle = titles.size > 1;
    const extra = withTitle ? ["Sheet", "Sheet title"] : ["Sheet"];
    const body = group.flatMap(({ s, g }) => {
      const at = names.map((n) => g.headings.indexOf(n));
      return g.body.map((r) => [s.name, ...(withTitle ? [g.title ?? ""] : []), ...at.map((i) => (i >= 0 ? (r[i] ?? "") : ""))]);
    });
    const combined = dropEmptyColumns({ headings: [...extra, ...names], body, title: withTitle ? undefined : group[0].g.title });
    if (!combined) continue;
    const first = group[0].s.name;
    const last = group[group.length - 1].s.name;
    const want = group.length === prepared.length ? stem : `${first} to ${last}`;
    await loadGrid(a, src, want, combined, `${group.length} sheets with the same columns ("${first}" to "${last}"), combined`);
  }
}

async function keepText(a: Analysis, src: Source, text: string) {
  const t = text.slice(0, DOC_TEXT_MAX);
  if (!t.trim()) return;
  await fs.mkdir(path.dirname(docFile(a, src.id)), { recursive: true });
  await fs.writeFile(docFile(a, src.id), t);
  src.textChars = t.length;
  if (text.length > DOC_TEXT_MAX) src.note = `Only the first ${DOC_TEXT_MAX.toLocaleString()} characters are kept.`;
}

/** Add one file to the analysis (the caller saves the analysis afterwards). */
export async function addFile(a: Analysis, name: string, bytes: Buffer): Promise<Source> {
  if (bytes.length > MAX_FILE_BYTES) throw new InsightsError(`${name} is over 100 MB.`);
  const e = ext(name);
  const src: Source = { id: randomUUID().slice(0, 8), name: name.slice(0, 200), size: bytes.length, kind: "text", at: new Date().toISOString(), tables: [] };
  const file = sourceFile(a, src);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  const stem = baseName(src.name);

  if (e === "xlsx" || e === "xlsm") {
    src.kind = "spreadsheet";
    const wb = await readWorkbook(bytes);
    await addWorkbook(a, src, stem, wb.sheets);
    if (!src.tables.length) src.note = "No sheet had rows of data.";
  } else if (e === "xls" || e === "doc" || e === "ppt") {
    throw new InsightsError(`${name} is an old Office format. Save it as .${e}x and add it again.`);
  } else if (e === "csv" || e === "tsv") {
    src.kind = "csv";
    const t = freeName(a, stem);
    const columns = await loadFile(a, t, file, "csv");
    a.tables.push({ name: t, source: src.name, rows: await rowCount(a, t), columns });
    src.tables.push(t);
  } else if (e === "json" || e === "ndjson" || e === "jsonl") {
    src.kind = "json";
    const t = freeName(a, stem);
    try {
      const columns = await loadFile(a, t, file, "json");
      a.tables.push({ name: t, source: src.name, rows: await rowCount(a, t), columns });
      src.tables.push(t);
    } catch {
      await keepText(a, src, bytes.toString("utf8"));
      src.note = "Not a list of records, kept as text.";
    }
  } else if (e === "parquet") {
    src.kind = "parquet";
    const t = freeName(a, stem);
    const columns = await loadFile(a, t, file, "parquet");
    a.tables.push({ name: t, source: src.name, rows: await rowCount(a, t), columns });
    src.tables.push(t);
  } else if (e === "docx") {
    src.kind = "document";
    await keepText(a, src, await docxText(bytes));
    for (const [i, g] of (await docxTables(bytes)).entries()) await addGrid(a, src, `${stem} table ${i + 1}`, g, `table ${i + 1}`);
  } else if (e === "pptx") {
    src.kind = "slides";
    await keepText(a, src, await pptxText(bytes));
    for (const [i, t] of (await pptxTables(bytes)).entries()) await addGrid(a, src, `${stem} table ${i + 1}`, t.rows, `slide ${t.slide}`);
  } else if (e === "pdf") {
    src.kind = "pdf";
    await keepText(a, src, (await pdfPages(bytes)).join("\n\n"));
    if (!src.textChars) src.note = "No text found: it may be a scanned image.";
  } else if (["md", "markdown", "txt", "text", "log", "html", "htm", "xml", "yaml", "yml"].includes(e)) {
    src.kind = "text";
    const text = bytes.toString("utf8");
    await keepText(a, src, text);
    const grids = e === "html" || e === "htm" ? htmlTables(text) : markdownTables(text);
    for (const [i, g] of grids.entries()) await addGrid(a, src, `${stem} table ${i + 1}`, g, `table ${i + 1}`);
  } else {
    throw new InsightsError(`${name}: this kind of file can't be read yet. Add Excel, CSV, JSON, Parquet, Word, PowerPoint, PDF, Markdown or text.`);
  }
  a.sources.push(src);
  return src;
}

/** A document's text, or part of it, for the AI. */
export async function readDoc(a: Analysis, sourceId: string, o: { from?: number; length?: number; find?: string } = {}) {
  const src = a.sources.find((s) => s.id === sourceId || s.name === sourceId);
  if (!src?.textChars) throw new InsightsError("That file has no text to read.");
  const text = await fs.readFile(docFile(a, src.id), "utf8");
  if (o.find) {
    const k = o.find.toLowerCase();
    const hits: string[] = [];
    let at = text.toLowerCase().indexOf(k);
    while (at >= 0 && hits.length < 20) {
      hits.push(`…[at ${at}] ${text.slice(Math.max(0, at - 400), at + 600)}…`);
      at = text.toLowerCase().indexOf(k, at + 600);
    }
    return hits.length ? hits.join("\n\n") : `"${o.find}" isn't in ${src.name}.`;
  }
  const from = Math.max(0, o.from ?? 0);
  const len = Math.min(o.length ?? 40_000, 60_000);
  const part = text.slice(from, from + len);
  return `${src.name}: characters ${from}–${from + part.length} of ${text.length}.${from + len < text.length ? ` Continue with from=${from + len}.` : ""}\n\n${part}`;
}
