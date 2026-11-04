import { db } from "./db";
import { commit, writeFiles } from "./repo";
import { sheetValues } from "./google";

/**
 * Google Sheets as live data for apps built in the Builder. Linking a sheet to
 * a project allows the app (preview and published) to read it through
 * /live/sheet/<project>/<sheet>, with the linking person's Google connection.
 * Only linked sheets can be read, never the rest of that person's Drive. The
 * project also gets src/lib/live-sheets.ts so the agent and the code know
 * how to read them.
 */
const origin = () => (process.env.EDITOR_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");

export async function linkedSheets(projectId: string) {
  return db.linkedSheet.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
}

function helperSource(projectId: string, sheets: { spreadsheetId: string; name: string }[]) {
  const list = sheets.map((s) => `  { id: ${JSON.stringify(s.spreadsheetId)}, name: ${JSON.stringify(s.name)} },`).join("\n");
  return `// Live Google Sheets linked to this app (managed by the platform; don't edit by hand).
// readSheet() returns the current cell values; poll it (e.g. every 60 seconds)
// to keep a dashboard live. Changes in the sheet show up within a minute.

export const LINKED_SHEETS = [
${list}
] as const;

export type SheetData = { range: string; values: string[][]; updatedAt: string };

const BASE = ${JSON.stringify(`${origin()}/api/live-sheet/${projectId}`)};

/** Values of a linked sheet; range like "Sheet1!A1:F200" (defaults to the first tab). */
export async function readSheet(spreadsheetId: string, range?: string): Promise<SheetData> {
  const url = \`\${BASE}/\${spreadsheetId}\${range ? \`?range=\${encodeURIComponent(range)}\` : ""}\`;
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't read the sheet");
  return res.json();
}

/** Rows as objects keyed by the header row. */
export async function readSheetRows(spreadsheetId: string, range?: string): Promise<Record<string, string>[]> {
  const { values } = await readSheet(spreadsheetId, range);
  const [head = [], ...rows] = values;
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
`;
}

async function writeHelper(projectId: string, author: { name: string; email: string } | null) {
  const sheets = await linkedSheets(projectId);
  await writeFiles(projectId, [{ path: "src/lib/live-sheets.ts", content: helperSource(projectId, sheets) }]);
  await commit(projectId, sheets.length ? "Link Google Sheets as live data" : "Unlink Google Sheets", author);
}

export async function linkSheet(projectId: string, userId: string, spreadsheetId: string, name: string, author: { name: string; email: string } | null) {
  await db.linkedSheet.upsert({
    where: { projectId_spreadsheetId: { projectId, spreadsheetId } },
    create: { projectId, spreadsheetId, name: name.slice(0, 200), linkedById: userId },
    update: { name: name.slice(0, 200), linkedById: userId },
  });
  await writeHelper(projectId, author);
}

export async function unlinkSheet(projectId: string, spreadsheetId: string, author: { name: string; email: string } | null) {
  await db.linkedSheet.deleteMany({ where: { projectId, spreadsheetId } });
  await writeHelper(projectId, author);
}

// Short cache so a dashboard with many viewers doesn't hit Google's limits.
const cache = new Map<string, { at: number; data: { range: string; values: string[][]; updatedAt: string } }>();

/** After an edit from the suite, apps reading this sheet get the new values on their next read. */
export function forgetSheet(spreadsheetId: string) {
  for (const k of cache.keys()) if (k.split(":")[1] === spreadsheetId) cache.delete(k);
}

export async function readLinked(projectId: string, spreadsheetId: string, range?: string) {
  const link = await db.linkedSheet.findUnique({ where: { projectId_spreadsheetId: { projectId, spreadsheetId } } });
  if (!link) return null;
  const key = `${projectId}:${spreadsheetId}:${range ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const v = await sheetValues(link.linkedById, spreadsheetId, range);
  const data = { ...v, updatedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return data;
}
