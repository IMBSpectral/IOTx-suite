import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { open, seal, type SecretBox } from "./secret-box";

/**
 * Google Drive, Docs, Sheets and Slides for a signed-in person. Uses the same
 * Google OAuth client as "Continue with Google" (AUTH_GOOGLE_ID/SECRET), but
 * asks separately for Drive and Sheets access (to browse, create, edit and
 * delete files), with offline access so live sheets keep updating.
 */
const PURPOSE = "google-refresh";
export const SCOPES = [
  "openid",
  "email",
  // Full Drive and Sheets: browse, create, rename, copy, trash, and edit sheet cells.
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  // IOTx Workspace Calendar: two-way sync of the primary calendar.
  "https://www.googleapis.com/auth/calendar",
];
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

export class GoogleError extends Error {
  /** Google's HTTP status and error status (e.g. 400 "FAILED_PRECONDITION"), when the error came from Google. */
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: string,
  ) {
    super(message);
  }
}

const origin = () => process.env.EDITOR_ORIGIN ?? process.env.AUTH_URL ?? "http://localhost:3000";
export const redirectUri = () => `${origin().replace(/\/$/, "")}/api/google/callback`;
export const googleConfigured = () => !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

// ── The connect flow (state signed with AUTH_SECRET, bound to the person) ──
function sign(v: string) {
  return crypto.createHmac("sha256", process.env.AUTH_SECRET ?? "dev").update(v).digest("base64url");
}
export function connectUrl(userId: string, email: string | null, back: string, opts: { scopes?: string[]; extra?: Record<string, string | null>; pickAccount?: boolean } = {}) {
  const nonce = crypto.randomBytes(12).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ u: userId, n: nonce, b: back, t: Date.now(), x: opts.extra ?? null })).toString("base64url");
  const state = `${payload}.${sign(payload)}`;
  const p = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: (opts.scopes ?? SCOPES).join(" "),
    access_type: "offline",
    prompt: opts.pickAccount ? "select_account consent" : "consent",
    include_granted_scopes: "true",
    state,
    ...(email && !opts.pickAccount ? { login_hint: email } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}
export function readState(state: string | null) {
  const [payload, sig] = (state ?? "").split(".");
  if (!payload || !sig || sign(payload) !== sig) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u: string; b: string; t: number; x: Record<string, string | null> | null };
  if (Date.now() - s.t > 15 * 60_000) return null;
  return s;
}

export async function tokenRequest(params: Record<string, string>) {
  // FORGE_GOOGLE_TOKEN_URL: tests point this at a mock.
  const r = await fetch(process.env.FORGE_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.AUTH_GOOGLE_ID ?? "", client_secret: process.env.AUTH_GOOGLE_SECRET ?? "", ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string; error_description?: string };
  if (!r.ok || !d.access_token) throw new GoogleError(d.error_description ?? d.error ?? `Google answered ${r.status}`);
  return d;
}

/** Finish connecting: swap the code for tokens and store them. */
export async function finishConnect(userId: string, code: string) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new GoogleError("Google didn't grant offline access. Try connecting again.");
  const scopes = t.scope ?? "";
  if (!/auth\/drive(\.readonly)?( |$)/.test(scopes)) throw new GoogleError("Drive access wasn't granted. Tick the Drive box on Google's screen and try again.");
  const email = t.id_token ? (JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()) as { email?: string }).email ?? "" : "";
  const data = {
    email,
    refresh: seal(PURPOSE, t.refresh_token) as unknown as Prisma.InputJsonValue,
    accessToken: t.access_token,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000),
    scopes,
  };
  await db.googleConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

export async function connectionOf(userId: string) {
  const c = await db.googleConnection.findUnique({ where: { userId }, select: { email: true, scopes: true, createdAt: true } });
  if (!c) return null;
  const granted = c.scopes.split(" ");
  // Connections made before editing existed only have read-only access.
  const canEdit = granted.includes("https://www.googleapis.com/auth/drive") && granted.includes("https://www.googleapis.com/auth/spreadsheets");
  const canCalendar = granted.includes(CALENDAR_SCOPE);
  return { ...c, canEdit, canCalendar };
}

/** For IOTx Workspace (server to server): a fresh token when the connection includes Calendar, else null. */
export async function calendarAccessToken(userId: string): Promise<string | null> {
  const c = await connectionOf(userId);
  if (!c?.canCalendar) return null;
  return accessToken(userId);
}

export async function disconnect(userId: string) {
  const c = await db.googleConnection.findUnique({ where: { userId } });
  if (!c) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(open(PURPOSE, c.refresh as unknown as SecretBox))}`, { method: "POST" });
  } catch {}
  await db.googleConnection.delete({ where: { userId } });
}

/** A valid access token for the person, refreshed when it has expired. */
async function accessToken(userId: string) {
  const c = await db.googleConnection.findUnique({ where: { userId } });
  if (!c) throw new GoogleError("Google Drive isn't connected.");
  if (c.accessToken && c.expiresAt && c.expiresAt > new Date()) return c.accessToken;
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: open(PURPOSE, c.refresh as unknown as SecretBox) });
    await db.googleConnection.update({ where: { userId }, data: { accessToken: t.access_token, expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000 - 60_000) } });
    return t.access_token!;
  } catch {
    throw new GoogleError("Google Drive access has expired or was removed. Connect it again.");
  }
}

async function gapi<T>(userId: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  // FORGE_GOOGLE_API: tests send every Google API call to a mock instead.
  const target = process.env.FORGE_GOOGLE_API ? url.replace(/^https:\/\/[a-z]+\.googleapis\.com/, process.env.FORGE_GOOGLE_API) : url;
  const r = await fetch(target, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${await accessToken(userId)}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d = (await r.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (!r.ok) {
    if (r.status === 403 && /has not been used|is disabled/i.test(d.error?.message ?? ""))
      throw new GoogleError("This Google API isn't switched on in the Google Cloud project yet (Drive, Sheets, Docs or Slides API).", r.status, d.error?.status);
    if (r.status === 404) throw new GoogleError("That file wasn't found, or you no longer have access to it.", 404, d.error?.status);
    if (r.status === 403 && /insufficient|scope/i.test(d.error?.message ?? "")) throw new GoogleError("Editing needs more Google access. Reconnect Google and allow editing.", 403, d.error?.status);
    if (r.status === 429) throw new GoogleError("Google is limiting how fast this file can be read. Try again in a minute.", 429, d.error?.status);
    throw new GoogleError(d.error?.message ?? `Google answered ${r.status}`, r.status, d.error?.status);
  }
  return d;
}

/** Raw bytes from Drive (file downloads and exports). */
async function graw(userId: string, url: string) {
  const target = process.env.FORGE_GOOGLE_API ? url.replace(/^https:\/\/[a-z]+\.googleapis\.com/, process.env.FORGE_GOOGLE_API) : url;
  const r = await fetch(target, { headers: { authorization: `Bearer ${await accessToken(userId)}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new GoogleError(r.status === 404 ? "That file wasn't found, or you no longer have access to it." : `Google answered ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export type DriveEntry = { id: string; name: string; mimeType: string; modifiedTime: string; size?: string };
const FOLDER = "application/vnd.google-apps.folder";

/** A folder's id from a Drive link or a bare id. */
export function folderIdFrom(s: string) {
  const t = s.trim();
  return /\/folders\/([\w-]{10,})/.exec(t)?.[1] ?? (/^[\w-]{10,}$/.test(t) ? t : null);
}

export async function driveFolder(userId: string, id: string) {
  const f = await gapi<DriveEntry>(userId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`);
  if (f.mimeType !== FOLDER) throw new GoogleError("That link isn't a Drive folder.");
  return f;
}

/** The files directly in a folder (not sub-folders), up to 200. */
export async function driveFolderFiles(userId: string, folderId: string) {
  const p = new URLSearchParams({
    q: `'${folderId.replace(/'/g, "")}' in parents and trashed=false and mimeType != '${FOLDER}'`,
    fields: "files(id, name, mimeType, modifiedTime, size)",
    pageSize: "200",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  return (await gapi<{ files: DriveEntry[] }>(userId, `https://www.googleapis.com/drive/v3/files?${p}`)).files ?? [];
}

/** A Drive file's content: Google Docs as Markdown, Sheets as CSV, Slides as text, anything else as the file itself. */
export async function driveContent(userId: string, f: DriveEntry): Promise<{ name: string; type: string; data: Buffer }> {
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`;
  if (f.mimeType === KINDS.docs.mime) return { name: `${f.name}.md`, type: "text/markdown", data: await graw(userId, `${base}/export?mimeType=text%2Fmarkdown`) };
  if (f.mimeType === KINDS.sheets.mime) return { name: `${f.name}.csv`, type: "text/csv", data: await graw(userId, `${base}/export?mimeType=text%2Fcsv`) };
  if (f.mimeType === KINDS.slides.mime) return { name: `${f.name}.txt`, type: "text/plain", data: await graw(userId, `${base}/export?mimeType=text%2Fplain`) };
  if (f.mimeType.startsWith("application/vnd.google-apps.")) throw new GoogleError("This kind of Google file can't be read.");
  if (Number(f.size ?? 0) > 20 * 1024 * 1024) throw new GoogleError("Files can be up to 20 MB.");
  return { name: f.name, type: f.mimeType, data: await graw(userId, `${base}?alt=media&supportsAllDrives=true`) };
}

export const KINDS = {
  docs: { mime: "application/vnd.google-apps.document", label: "Google Docs", preview: (id: string) => `https://docs.google.com/document/d/${id}/preview` },
  sheets: { mime: "application/vnd.google-apps.spreadsheet", label: "Google Sheets", preview: (id: string) => `https://docs.google.com/spreadsheets/d/${id}/preview` },
  slides: { mime: "application/vnd.google-apps.presentation", label: "Google Slides", preview: (id: string) => `https://docs.google.com/presentation/d/${id}/preview` },
} as const;
export type Kind = keyof typeof KINDS;

export type DriveFile = {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink: string;
  iconLink?: string;
  thumbnailLink?: string;
  owners?: { displayName?: string }[];
  viewedByMeTime?: string;
  starred?: boolean;
  ownedByMe?: boolean;
};

/** Sort orders for the file list, as Google's home screens offer them. */
const ORDERS: Record<string, string> = { opened: "viewedByMeTime desc", modifiedByMe: "modifiedByMeTime desc", modified: "modifiedTime desc", name: "name_natural" };

/** The person's Docs, Sheets or Slides, newest first, with optional name search, sort and owner filter. */
export async function listFiles(userId: string, kind: Kind, search?: string, pageToken?: string, opts: { order?: string; owner?: "me" | "notme" | "" } = {}) {
  const qParts = [`mimeType='${KINDS[kind].mime}'`, "trashed=false"];
  if (search) qParts.push(`name contains '${search.replace(/\\/g, "\\\\").replace(/'/g, "\\'").slice(0, 100)}'`);
  if (opts.owner === "me") qParts.push("'me' in owners");
  if (opts.owner === "notme") qParts.push("not 'me' in owners");
  const p = new URLSearchParams({
    q: qParts.join(" and "),
    orderBy: ORDERS[opts.order ?? ""] ?? "modifiedTime desc",
    pageSize: "50",
    fields: "nextPageToken, files(id, name, modifiedTime, viewedByMeTime, starred, ownedByMe, webViewLink, iconLink, thumbnailLink, owners(displayName))",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    ...(pageToken ? { pageToken } : {}),
  });
  return gapi<{ files: DriveFile[]; nextPageToken?: string }>(userId, `https://www.googleapis.com/drive/v3/files?${p}`);
}

export async function fileMeta(userId: string, id: string) {
  return gapi<DriveFile & { mimeType: string }>(userId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`);
}

/** Tabs of a spreadsheet. */
export async function sheetTabs(userId: string, spreadsheetId: string) {
  const d = await gapi<{ properties: { title: string }; sheets: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[] }>(
    userId,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`,
  );
  return { title: d.properties.title, tabs: d.sheets.map((s) => s.properties.title), ids: Object.fromEntries(d.sheets.map((s) => [s.properties.title, s.properties.sheetId])) as Record<string, number> };
}

/** Cell values of a range (default: the first tab), as displayed in the sheet. */
export async function sheetValues(userId: string, spreadsheetId: string, range?: string) {
  const r = range?.trim() || (await sheetTabs(userId, spreadsheetId)).tabs[0] || "A1:Z1000";
  const d = await gapi<{ range: string; values?: string[][] }>(
    userId,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(r)}?valueRenderOption=FORMATTED_VALUE`,
  );
  return { range: d.range, values: d.values ?? [] };
}

// ── Writing: create, rename, copy, trash; sheet cells, rows and tabs ──

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const FILE_FIELDS = "id,name,modifiedTime,webViewLink,owners(displayName)";

export async function createFile(userId: string, kind: Kind, name: string) {
  return gapi<DriveFile>(userId, `${DRIVE}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
    method: "POST",
    body: { name: name.trim().slice(0, 200) || "Untitled", mimeType: KINDS[kind].mime },
  });
}

export async function renameFile(userId: string, id: string, name: string) {
  return gapi<DriveFile>(userId, `${DRIVE}/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
    method: "PATCH",
    body: { name: name.trim().slice(0, 200) || "Untitled" },
  });
}

export async function copyFile(userId: string, id: string, name: string) {
  return gapi<DriveFile>(userId, `${DRIVE}/${encodeURIComponent(id)}/copy?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
    method: "POST",
    body: { name: name.trim().slice(0, 200) },
  });
}

/** Moves to Google Drive's Trash (restorable for 30 days); never deletes outright. */
export async function trashFile(userId: string, id: string) {
  await gapi(userId, `${DRIVE}/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "PATCH", body: { trashed: true } });
}

/** "A", "B", … "Z", "AA" … for a 0-based column. */
export function colName(i: number) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** Write one cell (row and col 0-based); values are read as if typed (numbers, dates, formulas). */
export async function setCell(userId: string, id: string, tab: string, row: number, col: number, value: string) {
  const range = `${quoteTab(tab)}!${colName(col)}${row + 1}`;
  await gapi(userId, `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values: [[value]] } });
}

export async function appendRow(userId: string, id: string, tab: string, values: string[]) {
  await gapi(userId, `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(quoteTab(tab))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: { values: [values] },
  });
}

/** Delete one row (0-based) from a tab. */
export async function deleteRow(userId: string, id: string, tab: string, row: number) {
  const { ids } = await sheetTabs(userId, id);
  if (ids[tab] === undefined) throw new GoogleError("That tab no longer exists.");
  await gapi(userId, `${SHEETS}/${encodeURIComponent(id)}:batchUpdate`, {
    method: "POST",
    body: { requests: [{ deleteDimension: { range: { sheetId: ids[tab], dimension: "ROWS", startIndex: row, endIndex: row + 1 } } }] },
  });
}

export async function addTab(userId: string, id: string, title: string) {
  await gapi(userId, `${SHEETS}/${encodeURIComponent(id)}:batchUpdate`, {
    method: "POST",
    body: { requests: [{ addSheet: { properties: { title: title.trim().slice(0, 100) || "Sheet" } } }] },
  });
}

// ── The Sheets editor (components/sheets): whole-spreadsheet layout, cell
// data with formats in row blocks, and batched writes. ──

type GColor = { red?: number; green?: number; blue?: number };
export type GridRange = { sheetId: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number };
export type SheetTab = {
  sheetId: number;
  title: string;
  index: number;
  hidden: boolean;
  color: GColor | null;
  rowCount: number;
  colCount: number;
  frozenRows: number;
  frozenCols: number;
  hideGridlines: boolean;
  merges: GridRange[];
  filter: { range: GridRange; filterSpecs?: unknown[] } | null;
};
export type EditorFile = DriveFile & { starred?: boolean; mimeType: string; capabilities?: { canEdit?: boolean; canShare?: boolean }; ownedByMe?: boolean };

/** File details for the editor's top bar (title, star, owner, whether Google lets them edit). */
export async function editorFile(userId: string, id: string) {
  return gapi<EditorFile>(
    userId,
    `${DRIVE}/${encodeURIComponent(id)}?fields=${encodeURIComponent("id,name,mimeType,modifiedTime,webViewLink,starred,ownedByMe,owners(displayName),capabilities(canEdit,canShare)")}&supportsAllDrives=true`,
  );
}

/** Mark the file as opened now, so "Last opened by me" matches Google's own home screen. */
export async function touchViewed(userId: string, id: string) {
  await gapi(userId, `${DRIVE}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id`, { method: "PATCH", body: { viewedByMeTime: new Date().toISOString() } });
}

export async function starFile(userId: string, id: string, starred: boolean) {
  return gapi<DriveFile & { starred?: boolean }>(userId, `${DRIVE}/${encodeURIComponent(id)}?fields=id,starred&supportsAllDrives=true`, { method: "PATCH", body: { starred } });
}

/** Every tab with its size, frozen rows and columns, merges and filter. */
export async function sheetLayout(userId: string, id: string) {
  type GSheet = {
    properties: { sheetId: number; title: string; index?: number; hidden?: boolean; tabColor?: GColor; tabColorStyle?: { rgbColor?: GColor }; gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number; frozenColumnCount?: number; hideGridlines?: boolean } };
    merges?: GridRange[];
    basicFilter?: { range: GridRange; filterSpecs?: unknown[] };
  };
  const fields = "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,hidden,tabColor,tabColorStyle,gridProperties),merges,basicFilter(range,filterSpecs))";
  const d = await gapi<{ properties: { title: string; locale?: string; timeZone?: string }; sheets?: GSheet[] }>(userId, `${SHEETS}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`);
  const tabs: SheetTab[] = (d.sheets ?? []).map((s, i) => {
    const g = s.properties.gridProperties ?? {};
    return {
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      index: s.properties.index ?? i,
      hidden: !!s.properties.hidden,
      color: s.properties.tabColorStyle?.rgbColor ?? s.properties.tabColor ?? null,
      rowCount: g.rowCount ?? 1000,
      colCount: g.columnCount ?? 26,
      frozenRows: g.frozenRowCount ?? 0,
      frozenCols: g.frozenColumnCount ?? 0,
      hideGridlines: !!g.hideGridlines,
      merges: s.merges ?? [],
      filter: s.basicFilter ?? null,
    };
  });
  return { title: d.properties.title, locale: d.properties.locale ?? "en_US", timeZone: d.properties.timeZone ?? "", tabs: tabs.sort((a, b) => a.index - b.index) };
}

/** A cell as the editor needs it: shown text, what was typed, the computed number, formats, link and note. */
export type GridCell = { v?: string; uv?: Record<string, unknown>; num?: number; bool?: 1; err?: string; uf?: Record<string, unknown>; link?: string; note?: string };

/**
 * Rows r0..r1 (0-based, end exclusive) of one tab with every column, as
 * Google shows them: formatted values, formulas, formats, row heights and
 * column widths (and rows hidden by a filter).
 */
export async function sheetGrid(userId: string, id: string, tab: string, r0: number, r1: number, colCount: number) {
  const range = `${quoteTab(tab)}!A${r0 + 1}:${colName(Math.max(0, Math.min(colCount, 18278) - 1))}${r1}`;
  const fields =
    "sheets(properties(sheetId),data(startRow,rowMetadata(pixelSize,hiddenByFilter,hiddenByUser),columnMetadata(pixelSize,hiddenByUser),rowData.values(formattedValue,userEnteredValue,effectiveValue,userEnteredFormat,hyperlink,note)))";
  type GCell = { formattedValue?: string; userEnteredValue?: Record<string, unknown>; effectiveValue?: { numberValue?: number; boolValue?: boolean; errorValue?: { message?: string; type?: string } }; userEnteredFormat?: Record<string, unknown>; hyperlink?: string; note?: string };
  const d = await gapi<{ sheets?: { data?: { startRow?: number; rowMetadata?: { pixelSize?: number; hiddenByFilter?: boolean; hiddenByUser?: boolean }[]; columnMetadata?: { pixelSize?: number; hiddenByUser?: boolean }[]; rowData?: { values?: GCell[] }[] }[] }[] }>(
    userId,
    `${SHEETS}/${encodeURIComponent(id)}?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`,
  );
  const data = d.sheets?.[0]?.data?.[0] ?? {};
  const rows: (GridCell | null)[][] = [];
  (data.rowData ?? []).forEach((row, i) => {
    rows[i] = (row.values ?? []).map((c) => {
      if (!c || (!c.formattedValue && !c.userEnteredValue && !c.userEnteredFormat && !c.note && !c.hyperlink)) return null;
      const o: GridCell = {};
      if (c.formattedValue) o.v = c.formattedValue;
      if (c.userEnteredValue) o.uv = c.userEnteredValue;
      if (typeof c.effectiveValue?.numberValue === "number") o.num = c.effectiveValue.numberValue;
      if (typeof c.effectiveValue?.boolValue === "boolean") o.bool = 1;
      if (c.effectiveValue?.errorValue) o.err = c.effectiveValue.errorValue.message ?? c.effectiveValue.errorValue.type ?? "Error";
      if (c.userEnteredFormat && Object.keys(c.userEnteredFormat).length) o.uf = c.userEnteredFormat;
      if (c.hyperlink) o.link = c.hyperlink;
      if (c.note) o.note = c.note;
      return o;
    });
  });
  return {
    r0,
    rows,
    rowPx: (data.rowMetadata ?? []).map((m) => (m.hiddenByFilter || m.hiddenByUser ? 0 : m.pixelSize ?? 21)),
    colPx: (data.columnMetadata ?? []).map((m) => (m.hiddenByUser ? 0 : m.pixelSize ?? 100)),
  };
}

/** The spreadsheets.batchUpdate requests the editor may send; anything else is refused. */
export const SHEET_REQUESTS = new Set([
  "repeatCell", "updateCells", "updateBorders", "mergeCells", "unmergeCells", "insertDimension", "deleteDimension", "appendDimension",
  "updateDimensionProperties", "autoResizeDimensions", "updateSheetProperties", "addSheet", "deleteSheet", "duplicateSheet", "sortRange",
  "setBasicFilter", "clearBasicFilter", "autoFill", "copyPaste", "cutPaste", "findReplace", "insertRange", "deleteRange",
]);
export type SheetOp = { t: "values"; data: { range: string; values: string[][] }[] } | { t: "batch"; requests: Record<string, unknown>[] };

/**
 * Writes in order: typed values through values.batchUpdate (USER_ENTERED, so
 * formulas, numbers and dates work as if typed), everything else through
 * spreadsheets.batchUpdate. Returns Google's replies for each step.
 */
export async function sheetWrite(userId: string, id: string, ops: SheetOp[]) {
  const replies: unknown[] = [];
  for (const op of ops) {
    if (op.t === "values") {
      if (!op.data.length) continue;
      replies.push(
        await gapi(userId, `${SHEETS}/${encodeURIComponent(id)}/values:batchUpdate`, { method: "POST", body: { valueInputOption: "USER_ENTERED", includeValuesInResponse: false, data: op.data } }),
      );
    } else {
      if (!op.requests.length) continue;
      replies.push(await gapi(userId, `${SHEETS}/${encodeURIComponent(id)}:batchUpdate`, { method: "POST", body: { requests: op.requests } }));
    }
  }
  return replies;
}

/** Checks the editor's writes before they go to Google: known request kinds and sane sizes. */
export function checkSheetOps(raw: unknown): SheetOp[] {
  if (!Array.isArray(raw) || raw.length > 50) throw new GoogleError("Too many changes at once.");
  let cells = 0;
  return raw.map((op) => {
    const o = op as { t?: string; data?: unknown; requests?: unknown };
    if (o.t === "values" && Array.isArray(o.data)) {
      const data = o.data.map((x) => {
        const d = x as { range?: unknown; values?: unknown };
        if (typeof d.range !== "string" || !Array.isArray(d.values)) throw new GoogleError("Bad value range.");
        const values = d.values.map((r) => (Array.isArray(r) ? r.map((v) => (v === null || v === undefined ? "" : String(v).slice(0, 50_000))) : []));
        cells += values.reduce((n, r) => n + r.length, 0);
        return { range: d.range.slice(0, 300), values };
      });
      if (cells > 200_000) throw new GoogleError("That's too many cells for one change.");
      return { t: "values", data };
    }
    if (o.t === "batch" && Array.isArray(o.requests)) {
      if (o.requests.length > 500) throw new GoogleError("Too many changes at once.");
      for (const r of o.requests) {
        const keys = r && typeof r === "object" ? Object.keys(r) : [];
        if (keys.length !== 1 || !SHEET_REQUESTS.has(keys[0])) throw new GoogleError(`That kind of change isn't allowed here (${keys.join(", ") || "empty"}).`);
      }
      return { t: "batch", requests: o.requests as Record<string, unknown>[] };
    }
    throw new GoogleError("Unknown change.");
  });
}

// ── The Docs and Slides editors (components/docs, components/slides): the
// whole document or presentation as Google returns it, batched writes with
// the revision they were based on, Drive exports, thumbnails and image uploads.
// The "drive" scope already covers the Docs and Slides APIs, so no new scope
// (and no reconnect) is needed. ──

const DOCS = "https://docs.googleapis.com/v1/documents";
const SLIDES = "https://slides.googleapis.com/v1/presentations";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const enc = encodeURIComponent;
const toMock = (url: string) => (process.env.FORGE_GOOGLE_API ? url.replace(/^https:\/\/[a-z]+\.googleapis\.com/, process.env.FORGE_GOOGLE_API) : url);

/** A Google Doc with suggestions shown inline: the indexes batchUpdate expects. */
export async function docGet(userId: string, id: string) {
  return gapi<Record<string, unknown> & { documentId: string; title: string; revisionId?: string }>(userId, `${DOCS}/${enc(id)}?suggestionsViewMode=SUGGESTIONS_INLINE`);
}

export async function slidesGet(userId: string, id: string) {
  return gapi<Record<string, unknown> & { presentationId: string; title?: string; revisionId?: string }>(userId, `${SLIDES}/${enc(id)}`);
}

/** Someone else changed the file after the revision the editor's changes were based on. */
const isConflict = (e: unknown) => e instanceof GoogleError && e.code === 400 && (e.status === "FAILED_PRECONDITION" || /revision/i.test(e.message));

/**
 * documents.batchUpdate or presentations.batchUpdate, all or nothing, based on
 * `revisionId` (writeControl.requiredRevisionId). A conflict comes back as
 * { conflict: true } so the editor can read the file again and replay.
 */
export async function officeWrite(userId: string, kind: "docs" | "slides", id: string, requests: Record<string, unknown>[], revisionId?: string | null) {
  const url = kind === "docs" ? `${DOCS}/${enc(id)}:batchUpdate` : `${SLIDES}/${enc(id)}:batchUpdate`;
  try {
    const d = await gapi<{ replies?: unknown[]; writeControl?: { requiredRevisionId?: string } }>(userId, url, {
      method: "POST",
      body: { requests, ...(revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}) },
    });
    return { replies: d.replies ?? [], revisionId: d.writeControl?.requiredRevisionId ?? null, conflict: false };
  } catch (e) {
    if (isConflict(e)) return { replies: [], revisionId: null, conflict: true };
    throw e;
  }
}

/** The requests each editor may send; anything else is refused. */
export const DOC_REQUESTS = new Set([
  "insertText", "deleteContentRange", "updateTextStyle", "updateParagraphStyle", "createParagraphBullets", "deleteParagraphBullets",
  "insertTable", "insertTableRow", "insertTableColumn", "deleteTableRow", "deleteTableColumn", "insertInlineImage", "insertPageBreak", "replaceAllText",
]);
export const SLIDE_REQUESTS = new Set([
  "createSlide", "deleteObject", "duplicateObject", "updateSlidesPosition", "createShape", "createImage", "createTable", "createLine",
  "insertText", "deleteText", "updateTextStyle", "updateParagraphStyle", "updatePageElementTransform", "updateShapeProperties",
  "insertTableRows", "insertTableColumns", "deleteTableRow", "deleteTableColumn", "replaceAllText", "createParagraphBullets", "deleteParagraphBullets",
]);

/** Checks an editor's batch before it goes to Google: known request kinds and sane sizes. */
export function checkOfficeRequests(raw: unknown, allowed: Set<string>) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 500) throw new GoogleError("Too many changes at once.");
  if (JSON.stringify(raw).length > 2_000_000) throw new GoogleError("That change is too large.");
  for (const r of raw) {
    const keys = r && typeof r === "object" ? Object.keys(r) : [];
    if (keys.length !== 1 || !allowed.has(keys[0])) throw new GoogleError(`That kind of change isn't allowed here (${keys.join(", ") || "empty"}).`);
  }
  return raw as Record<string, unknown>[];
}

/** Drive's export of a Google file (PDF, DOCX, PPTX, …); Google caps exports at 10 MB. */
export const EXPORTS: Record<string, { mime: string; ext: string }> = {
  pdf: { mime: "application/pdf", ext: "pdf" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  odt: { mime: "application/vnd.oasis.opendocument.text", ext: "odt" },
  rtf: { mime: "application/rtf", ext: "rtf" },
  txt: { mime: "text/plain", ext: "txt" },
  md: { mime: "text/markdown", ext: "md" },
  epub: { mime: "application/epub+zip", ext: "epub" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  odp: { mime: "application/vnd.oasis.opendocument.presentation", ext: "odp" },
};
export async function driveExport(userId: string, id: string, format: string) {
  const f = EXPORTS[format];
  if (!f) throw new GoogleError("Unknown format.");
  return { ...f, data: await graw(userId, `${DRIVE}/${enc(id)}/export?mimeType=${enc(f.mime)}`) };
}

/** A slide's picture as Google renders it: a short-lived URL (about 30 minutes). An expensive read in Google's quota. */
export async function slideThumb(userId: string, id: string, pageId: string, size: "SMALL" | "MEDIUM" | "LARGE") {
  return gapi<{ contentUrl: string; width?: number; height?: number }>(
    userId,
    `${SLIDES}/${enc(id)}/pages/${enc(pageId)}/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=${size}`,
  );
}

/** Comments on a file (Drive API), to read next to the document. */
export async function fileComments(userId: string, id: string) {
  const fields = "comments(id,content,createdTime,resolved,author(displayName),quotedFileContent(value),replies(content,author(displayName)))";
  return (await gapi<{ comments?: unknown[] }>(userId, `${DRIVE}/${enc(id)}/comments?pageSize=100&fields=${enc(fields)}`)).comments ?? [];
}

/**
 * An image put into the person's Drive so Docs or Slides can fetch it: Google
 * only inserts images from a public link, so the file is shared "anyone with
 * the link" until it has been inserted (unshareImage), then private again.
 */
export async function uploadImage(userId: string, name: string, type: string, data: Buffer) {
  if (!/^image\/(png|jpeg|gif)$/.test(type)) throw new GoogleError("Images can be PNG, JPEG or GIF.");
  if (data.length > 10 * 1024 * 1024) throw new GoogleError("Images can be up to 10 MB.");
  const boundary = `forge${crypto.randomBytes(8).toString("hex")}`;
  const meta = JSON.stringify({ name: name.slice(0, 200) || "Image", mimeType: type });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch(toMock(`${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType`), {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(userId)}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const d = (await r.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!r.ok || !d.id) throw new GoogleError(d.error?.message ?? `Google answered ${r.status}`, r.status);
  let permissionId: string;
  try {
    permissionId = (await gapi<{ id: string }>(userId, `${DRIVE}/${enc(d.id)}/permissions?supportsAllDrives=true&fields=id`, { method: "POST", body: { type: "anyone", role: "reader" } })).id;
  } catch (e) {
    throw new GoogleError(`The image was saved to your Drive, but it can't be shared by link for Google to insert it (${(e as Error).message}). Insert it by URL instead.`);
  }
  return { fileId: d.id, permissionId, uri: `https://drive.google.com/uc?export=download&id=${d.id}` };
}
export async function unshareImage(userId: string, fileId: string, permissionId: string) {
  await gapi(userId, `${DRIVE}/${enc(fileId)}/permissions/${enc(permissionId)}?supportsAllDrives=true`, { method: "DELETE" });
}
