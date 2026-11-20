import * as files from "./files";
import * as g from "./google";
import { docxText, pdfPages, pptxText, xlsxText } from "./uploads";

/**
 * Files reached through the suite-wide @: an item in Files (/drive?file=<id>) or in the
 * person's Google Drive (/gdrive?file=<id>). Read as the person who mentioned them, so only
 * what they can already open.
 */

export const FILE_REF = /^\/(drive|gdrive)\?(?:.*&)?file=([\w-]{6,})/;

/** Which file a suite link points at, or null. */
export function fileRef(pathAndQuery: string): { where: "files" | "gdrive"; id: string } | null {
  const m = FILE_REF.exec(pathAndQuery);
  return m ? { where: m[1] === "drive" ? "files" : "gdrive", id: m[2] } : null;
}

/** The file itself: name, type and bytes. Google Docs, Sheets and Slides come as Markdown, CSV and text. */
export async function refBytes(userId: string, workspaceId: string, ref: { where: "files" | "gdrive"; id: string }) {
  if (ref.where === "files") return files.fileBytes(userId, workspaceId, ref.id);
  const meta = await g.fileMeta(userId, ref.id);
  return g.driveContent(userId, { id: ref.id, name: meta.name, mimeType: meta.mimeType, modifiedTime: meta.modifiedTime ?? "", size: meta.size });
}

const TEXTY = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|sql))/;
const TEXT_EXT = /\.(txt|md|csv|tsv|json|xml|ya?ml|html?|log|sql|js|ts|tsx|jsx|css|py)$/i;

/** What the AI can read of a file: its text, or a one-line note when it can't be read as text. */
export async function bytesToText(f: { name: string; type: string; data: Buffer }): Promise<string> {
  const name = f.name.toLowerCase();
  try {
    if (TEXTY.test(f.type) || TEXT_EXT.test(name)) return f.data.toString("utf8");
    if (/\.(xlsx|xlsm|xls)$/.test(name) || /spreadsheetml|ms-excel/.test(f.type)) return await xlsxText(f.data);
    if (/\.docx$/.test(name) || /wordprocessingml/.test(f.type)) return await docxText(f.data);
    if (/\.pptx$/.test(name) || /presentationml/.test(f.type)) return await pptxText(f.data);
    if (/\.pdf$/.test(name) || f.type === "application/pdf") return (await pdfPages(f.data)).join("\n\n");
  } catch (e) {
    return `(${f.name} couldn't be read: ${e instanceof Error ? e.message : String(e)})`;
  }
  if (f.type.startsWith("image/")) return `(${f.name} is an image, ${Math.round(f.data.length / 1024)} KB. Its picture isn't included as text.)`;
  return `(${f.name} is a ${f.type || "binary"} file, ${Math.round(f.data.length / 1024)} KB, that can't be read as text.)`;
}
