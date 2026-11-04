import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECTS_ROOT } from "./paths";
import { compressImage } from "./image-compress";

/**
 * Files attached to chat messages: images, PDFs, documents and pasted text.
 *
 * Stored outside the project's git repository, so an attachment is something
 * the agent can look at, not something that silently becomes part of the app.
 * The agent copies one into the project only when asked (save_attachment).
 */

export type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Set when a large image was compressed for the agent; the original is kept too. */
  originalSize?: number;
};

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|sql|x-yaml))/;
const TEXT_EXT = new Set([
  "txt", "md", "csv", "json", "html", "css", "js", "jsx", "ts", "tsx", "sql", "svg",
  "log", "yml", "yaml", "xml", "env", "py",
]);

function dir(projectId: string) {
  return path.join(PROJECTS_ROOT, "_uploads", projectId);
}

/** Keep only characters that are safe in a file name. */
function cleanName(name: string) {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").trim();
  return base.slice(-120) || "file";
}

export async function saveUpload(
  projectId: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<Attachment> {
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new Error("File is larger than 20 MB");
  const id = crypto.randomUUID();
  const meta: Attachment = {
    id,
    name: cleanName(file.name),
    type: file.type || "application/octet-stream",
    size: file.bytes.length,
  };
  await fs.mkdir(dir(projectId), { recursive: true });
  const smaller = await compressImage(file.bytes, meta.type).catch(() => null);
  if (smaller) {
    await fs.writeFile(path.join(dir(projectId), `${id}.orig`), file.bytes);
    meta.originalSize = file.bytes.length;
    meta.size = smaller.length;
  }
  await fs.writeFile(path.join(dir(projectId), `${id}.bin`), smaller ?? file.bytes);
  await fs.writeFile(path.join(dir(projectId), `${id}.json`), JSON.stringify(meta));
  return meta;
}

/** An upload's bytes; `original` asks for the uncompressed file when one was kept. */
export async function readUpload(projectId: string, id: string, opts: { original?: boolean } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(dir(projectId), `${id}.json`), "utf8"),
    ) as Attachment;
    const file = opts.original && meta.originalSize ? `${id}.orig` : `${id}.bin`;
    const bytes = await fs.readFile(path.join(dir(projectId), file));
    return { meta, bytes };
  } catch {
    return null;
  }
}

/** Every file attached in this project's chat, newest first. */
export async function listUploads(projectId: string): Promise<(Attachment & { at: string })[]> {
  const names = await fs.readdir(dir(projectId)).catch(() => [] as string[]);
  const out: (Attachment & { at: string })[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const p = path.join(dir(projectId), n);
    const [raw, stat] = await Promise.all([fs.readFile(p, "utf8").catch(() => null), fs.stat(p).catch(() => null)]);
    if (!raw || !stat) continue;
    try {
      out.push({ ...(JSON.parse(raw) as Attachment), at: stat.mtime.toISOString() });
    } catch {
      // A half-written upload; skip it.
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Validate attachment ids against this project's uploads. */
export async function resolveAttachments(projectId: string, ids: string[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const id of ids.slice(0, 10)) {
    const u = await readUpload(projectId, id);
    if (u) out.push(u.meta);
  }
  return out;
}

export function isTextLike(a: Attachment) {
  const ext = a.name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_TYPES.test(a.type) || TEXT_EXT.has(ext);
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// What one turn may carry: the API takes about 32 MB per request (base64 counts),
// and a PDF sent as a document is limited to 100 pages. Text is capped as well.
const INLINE_BUDGET = 20 * 1024 * 1024;
const PDF_INLINE_MAX = 4 * 1024 * 1024;
const PDF_INLINE_PAGES = 90;
const TEXT_BUDGET = 200_000;
const TEXT_PER_FILE = 60_000;

const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Word: paragraphs in order (headings as #). */
async function docxText(bytes: Buffer) {
  const JSZip = (await import("jszip")).default;
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")?.async("string");
  if (!xml) return "";
  return xml
    .split(/<\/w:p>/)
    .map((p) => {
      const t = xmlText([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => (m[0].startsWith("<w:tab") ? "\t" : m[1])).join("")).trim();
      const h = /<w:pStyle w:val="(?:Heading|heading)\s?(\d)"/.exec(p)?.[1];
      return t ? (h ? `${"#".repeat(Math.min(3, Number(h)))} ${t}` : t) : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Excel: every sheet as tab-separated rows (values as shown in the cells' stored form). */
export async function xlsxText(bytes: Buffer, maxRows = 400) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const shared = [...((await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlText([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const book = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const target = (rid: string) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
  const col = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const out: string[] = [];
  for (const m of book.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const t = target(m[2]);
    const file = (t?.[1] ?? t?.[2] ?? "").replace(/^\/?(xl\/)?/, "xl/");
    const xml = await zip.file(file)?.async("string");
    if (!xml) continue;
    const rows: string[] = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const kind = /t="(\w+)"/.exec(c[2])?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(c[3] ?? "")?.[1] ?? "";
        const val = kind === "s" ? shared[Number(v)] ?? "" : kind === "inlineStr" ? xmlText([...(c[3] ?? "").matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join("")) : xmlText(v);
        cells[col(c[1])] = val.replace(/\s+/g, " ").trim();
      }
      if (cells.some(Boolean)) rows.push(Array.from(cells, (x) => x ?? "").join("\t"));
      if (rows.length >= maxRows) break;
    }
    if (rows.length) out.push(`## Sheet: ${xmlText(m[1])}\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}

/** PowerPoint: each slide's text. */
async function pptxText(bytes: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  const out: string[] = [];
  for (const [i, f] of slides.entries()) {
    const xml = (await zip.file(f)?.async("string")) ?? "";
    const t = xmlText([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" ")).trim();
    if (t) out.push(`## Slide ${i + 1}\n${t}`);
  }
  return out.join("\n\n");
}

/** PDF text, page by page (for PDFs too big to send whole). */
async function pdfPages(bytes: Buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((t, i) => (t.trim() ? `## Page ${i + 1}\n${t.trim()}` : "")).filter(Boolean);
}

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/**
 * Turn attachments into content blocks the model can read, within what one
 * request can carry: images as images (already shrunk at upload), small PDFs
 * as documents and larger ones as their text page by page, Word / Excel /
 * PowerPoint as their text and tables, text files inline. What doesn't fit
 * the budget, or can't be read, is listed by name with the reason, so the
 * model knows it's there.
 */
export async function attachmentBlocks(projectId: string, list: Attachment[]) {
  const blocks: (
    | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string } }
    | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title: string }
    | { type: "text"; text: string }
  )[] = [];
  const lines: string[] = [];
  let inline = 0;
  let textLeft = TEXT_BUDGET;
  const addText = (name: string, text: string, how: string) => {
    if (textLeft <= 0) return "not read (too much text in one message; send it on its own)";
    const t = text.slice(0, Math.min(TEXT_PER_FILE, textLeft));
    textLeft -= t.length;
    blocks.push({ type: "text", text: `Attached file ${name} (${how}${t.length < text.length ? ", shortened" : ""}):\n\n${t}` });
    return "";
  };

  for (const a of list) {
    const u = await readUpload(projectId, a.id);
    if (!u) continue;
    let note = "";
    const e = ext(a.name);
    try {
      if (IMAGE_TYPES.has(a.type) && u.bytes.length <= 5 * 1024 * 1024) {
        const b64 = Math.ceil(u.bytes.length / 3) * 4;
        if (inline + b64 > INLINE_BUDGET) note = "image not shown (too many large files in one message)";
        else {
          inline += b64;
          blocks.push({ type: "image", source: { type: "base64", media_type: a.type as "image/png", data: u.bytes.toString("base64") } });
        }
      } else if (a.type === "application/pdf" || e === "pdf") {
        const b64 = Math.ceil(u.bytes.length / 3) * 4;
        const pages = u.bytes.length <= PDF_INLINE_MAX && inline + b64 <= INLINE_BUDGET ? await pdfPages(u.bytes).catch(() => null) : null;
        if (pages && pages.length <= PDF_INLINE_PAGES) {
          inline += b64;
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: u.bytes.toString("base64") }, title: a.name });
        } else {
          const text = (pages ?? (await pdfPages(u.bytes).catch(() => []))).join("\n\n");
          note = text ? addText(a.name, text, "PDF text") : "a scanned PDF with no text to read";
        }
      } else if (e === "docx" || a.type.includes("wordprocessingml")) {
        const text = await docxText(u.bytes);
        note = text ? addText(a.name, text, "Word document") : "no text found";
      } else if (e === "xlsx" || e === "xlsm" || a.type.includes("spreadsheetml")) {
        const text = await xlsxText(u.bytes);
        note = text ? addText(a.name, text, "Excel workbook, tab-separated rows") : "no cells found";
      } else if (e === "pptx" || a.type.includes("presentationml")) {
        const text = await pptxText(u.bytes);
        note = text ? addText(a.name, text, "PowerPoint slides") : "no text found";
      } else if (isTextLike(a)) {
        note = addText(a.name, u.bytes.toString("utf8"), "text");
      } else if (e === "doc" || e === "xls" || e === "ppt") {
        note = "old Office format; save it as .docx, .xlsx or .pptx to have it read";
      }
    } catch {
      note = "couldn't be read";
    }
    lines.push(`- ${a.name} (${a.type || e}, ${Math.ceil(a.size / 1024)} KB) — id ${a.id}${note ? ` — ${note}` : ""}`);
  }

  const index = lines.length
    ? "Files attached to this message (use save_attachment to put one into the project, e.g. a logo or photo):\n" +
      lines.join("\n")
    : "";
  return { blocks, index };
}
