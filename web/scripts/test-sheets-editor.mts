/**
 * The Sheets editor's API (/api/google/sheets/<id>) against the Google mock
 * in scripts/lib/google-sheets-mock.mts on 127.0.0.1:4799. Start the server
 * with FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token
 * FORGE_GOOGLE_API=http://127.0.0.1:4799, then:
 *   npx tsx scripts/test-sheets-editor.mts <devToken>
 * The dev user's Google connection is replaced for the run and put back after.
 */
import "dotenv/config";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { seal } from "../src/lib/secret-box";
import { demoBook, SHEET_MIME, startGoogleMock } from "./lib/google-sheets-mock";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const DEV = `authjs.session-token=${token}`;
let passed = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` - ${detail}` : ""}`);
  if (ok) passed++;
  else failures++;
}
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie: DEV } } : { method: "POST", headers: { cookie: DEV, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as J };
};
const ID = "sheetdemo";
const api = `/api/google/sheets/${ID}`;
const write = (ops: unknown[]) => call(api, { action: "write", ops });
const batch = (...requests: unknown[]) => ({ t: "batch", requests });
const grid = async (tab: string, r0 = 0, r1 = 50, cols = 26) => (await call(`${api}?view=grid&${new URLSearchParams({ tab, r0: String(r0), r1: String(r1), cols: String(cols) })}`)).json;
const meta = async () => (await call(`${api}?view=meta`)).json;
const v = (g: J, r: number, c: number) => g.rows?.[r]?.[c]?.v as string | undefined;

const demo = demoBook(ID);
const mock = await startGoogleMock(4799, {
  files: [
    demo.file,
    { id: "shared1", name: "Price list (shared with me)", mimeType: SHEET_MIME, modifiedTime: "2026-09-01T10:00:00Z", ownedByMe: false, owner: "Asha", canEdit: false },
    { id: "doc1", name: "Policy", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-02T10:00:00Z" },
  ],
  books: [demo.book, { id: "shared1", title: "Price list", locale: "en_IN", sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0, gridProperties: { rowCount: 100, columnCount: 10 } }, cells: [[{ userEnteredValue: { stringValue: "Item" } }]], rowPx: new Map(), colPx: new Map(), merges: [] }] }],
});
const S = mock.books[ID];
const sheetOf = (title: string) => S.sheet(title)!;

const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const before = await db.googleConnection.findUnique({ where: { userId: dev.id } });
const conn = {
  email: "dev@gtest.dev",
  refresh: seal("google-refresh", "rt-dev") as unknown as Prisma.InputJsonValue,
  accessToken: null,
  expiresAt: null,
  scopes: "openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
};

try {
  await db.googleConnection.upsert({ where: { userId: dev.id }, create: { userId: dev.id, ...conn }, update: conn });

  // ── Home ──
  const list = (await call("/api/google?view=files&kind=sheets&order=opened")).json;
  check("home lists spreadsheets, last opened first", list.files?.[0]?.id === ID && list.files.length === 2 && mock.calls.some((c) => c.path.replace(/\+/g, " ").includes("orderBy=viewedByMeTime desc")), JSON.stringify(list).slice(0, 300));
  check("home sends viewedByMeTime, starred and ownedByMe", mock.calls.some((c) => c.path.includes("viewedByMeTime") && c.path.includes("ownedByMe") && c.path.includes("starred")));
  const notMine = (await call("/api/google?view=files&kind=sheets&owner=notme")).json;
  check("owner filter: not owned by me", notMine.files?.length === 1 && notMine.files[0].id === "shared1" && mock.calls.some((c) => c.path.replace(/\+/g, " ").includes("not 'me' in owners")), JSON.stringify(notMine).slice(0, 300));
  const byName = (await call("/api/google?view=files&kind=sheets&order=name")).json;
  check("sort by title", byName.files?.[0]?.name === "Price list (shared with me)" && mock.calls.some((c) => c.path.includes("orderBy=name_natural")));
  const search = (await call("/api/google?view=files&kind=sheets&q=Q3")).json;
  check("search by name", search.files?.length === 1 && search.files[0].id === ID);

  // ── Opening ──
  const m0 = (await call(`${api}?view=meta&touch=1`)).json;
  check("meta has the title, tabs and file details", m0.title === "Q3 Sales (demo)" && m0.tabs?.length === 2 && m0.file?.webViewLink?.includes(ID) && m0.canEdit === true);
  const orders = m0.tabs?.find((t: J) => t.title === "Orders");
  check("meta has frozen rows and columns, grid size", orders?.frozenRows === 1 && orders?.frozenCols === 1 && orders?.rowCount === 12001 && orders?.colCount === 8);
  check("meta has merges", m0.tabs?.[0]?.merges?.length === 1 && m0.tabs[0].merges[0].endColumnIndex === 5);
  await new Promise((r) => setTimeout(r, 300));
  check("opening marks the file as opened (viewedByMeTime)", mock.calls.some((c) => c.method === "PATCH" && c.body?.viewedByMeTime));
  const g0 = await grid("Summary", 0, 200);
  check("grid: formatted values and formulas from Google", v(g0, 3, 4) === "$59,520" && g0.rows[3][4].uv?.formulaValue === "=SUM(B4:D4)" && g0.rows[3][4].num === 59520);
  check("grid: formats (bold, fill, number format, alignment)", g0.rows[2][0].uf?.textFormat?.bold === true && !!g0.rows[0][0].uf?.backgroundColorStyle && g0.rows[0][0].uf?.horizontalAlignment === "CENTER" && g0.rows[3][1].uf?.numberFormat?.type === "CURRENCY");
  check("grid: row heights and column widths", g0.rowPx?.[0] === 32 && g0.colPx?.[0] === 140 && g0.colPx?.length === 26);
  check("grid: notes and percent", g0.rows[3][0].note?.includes("Chandigarh") && v(g0, 9, 1) === "11.7%");
  check("grid reads one block with includeGridData", mock.calls.some((c) => c.path.includes("includeGridData=true") && c.path.includes("ranges='Summary'!A1:Z200")));
  const deep = await grid("Orders", 10000, 10200, 8);
  check("grid: rows deep in a 12,000-row sheet load by block", deep.rows?.length === 200 && v(deep, 0, 0) === "SO-20000" && /^\d/.test(v(deep, 0, 6) ?? ""));

  // ── Values (USER_ENTERED) ──
  let w = await write([{ t: "values", data: [{ range: "'Summary'!B4", values: [["20000"]] }, { range: "'Summary'!F4", values: [["=B4*2"]] }] }]);
  const g1 = await grid("Summary");
  check("typed values and formulas: Google computes the totals", w.status === 200 && v(g1, 3, 4) === "$61,120" && v(g1, 3, 5) === "40000" && v(g1, 7, 4) === "$220,610");
  check("values go through values.batchUpdate with USER_ENTERED", mock.calls.some((c) => c.path.endsWith("/values:batchUpdate") && c.body?.valueInputOption === "USER_ENTERED"));
  w = await write([{ t: "values", data: [{ range: "'Summary'!G4", values: [["12%"]] }] }]);
  check("12% is read as a percent", (await grid("Summary")).rows[3][6]?.uv?.numberValue === 0.12);

  // ── Formats ──
  w = await write([batch({ repeatCell: { range: { sheetId: 0, startRowIndex: 3, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { italic: true } } }, fields: "userEnteredFormat.textFormat.italic" } })]);
  let g = await grid("Summary");
  check("repeatCell sets italic on a range and keeps other formats", w.status === 200 && g.rows[4][0].uf?.textFormat?.italic === true && g.rows[2][0].uf?.textFormat?.bold === true && !g.rows[2][0].uf?.textFormat?.italic);
  w = await write([batch({ repeatCell: { range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } })]);
  check("number format: 20,000.00", v(await grid("Summary"), 3, 1) === "20,000.00");
  w = await write([batch({ repeatCell: { range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat.numberFormat" } })]);
  check("Automatic clears the number format", !(await grid("Summary")).rows[3][1].uf?.numberFormat && v(await grid("Summary"), 3, 1) === "20000");
  w = await write([batch({ updateBorders: { range: { sheetId: 0, startRowIndex: 3, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 3 }, top: { style: "SOLID", colorStyle: { rgbColor: { red: 1 } } }, innerVertical: { style: "DASHED" } } })]);
  g = await grid("Summary");
  check("updateBorders: outer and inner borders", w.status === 200 && g.rows[3][1].uf?.borders?.top?.style === "SOLID" && g.rows[4][1].uf?.borders?.right?.style === "DASHED" && !g.rows[4][1].uf?.borders?.top);
  w = await write([batch({ mergeCells: { range: { sheetId: 0, startRowIndex: 13, endRowIndex: 15, startColumnIndex: 0, endColumnIndex: 2 }, mergeType: "MERGE_ALL" } })]);
  check("mergeCells", w.status === 200 && (await meta()).tabs[0].merges.length === 2);
  w = await write([batch({ mergeCells: { range: { sheetId: 0, startRowIndex: 14, endRowIndex: 16, startColumnIndex: 0, endColumnIndex: 1 }, mergeType: "MERGE_ALL" } })]);
  check("an overlapping merge is refused with Google's message", w.status === 400 && /overlap/i.test(w.json.error ?? ""));
  w = await write([batch({ unmergeCells: { range: { sheetId: 0, startRowIndex: 13, endRowIndex: 15, startColumnIndex: 0, endColumnIndex: 2 } } })]);
  check("unmergeCells", w.status === 200 && (await meta()).tabs[0].merges.length === 1);

  // ── Rows, columns, sizes, freeze ──
  w = await write([batch({ insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 3, endIndex: 5 }, inheritFromBefore: true } })]);
  check("insert 2 rows above row 4", w.status === 200 && v(await grid("Summary"), 5, 0) === "North" && (await meta()).tabs[0].rowCount === 1002);
  w = await write([batch({ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 3, endIndex: 5 } } })]);
  check("delete them again", w.status === 200 && v(await grid("Summary"), 3, 0) === "North" && (await meta()).tabs[0].rowCount === 1000);
  w = await write([batch({ insertDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, inheritFromBefore: true } }, { deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 2 } } })]);
  check("insert and delete a column in one batch", w.status === 200 && v(await grid("Summary"), 2, 1) === "July");
  w = await write([batch({ updateDimensionProperties: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 2, endIndex: 4 }, properties: { pixelSize: 180 }, fields: "pixelSize" } }, { updateDimensionProperties: { range: { sheetId: 0, dimension: "ROWS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 40 }, fields: "pixelSize" } })]);
  g = await grid("Summary");
  check("resize columns and rows", g.colPx[2] === 180 && g.colPx[3] === 180 && g.rowPx[2] === 40);
  w = await write([batch({ autoResizeDimensions: { dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 4, endIndex: 5 } } })]);
  check("fit a column to its data", w.status === 200 && (await grid("Summary")).colPx[4] !== 100);
  w = await write([batch({ updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 3, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } })]);
  let mm = await meta();
  check("freeze 3 rows and 1 column", mm.tabs[0].frozenRows === 3 && mm.tabs[0].frozenCols === 1 && mm.tabs[0].rowCount === 1000);
  w = await write([batch({ updateSheetProperties: { properties: { sheetId: 0, gridProperties: { hideGridlines: true } }, fields: "gridProperties.hideGridlines" } })]);
  check("hide gridlines", (await meta()).tabs[0].hideGridlines === true);

  // ── Sort, filter, fill, copy and paste, find and replace ──
  w = await write([batch({ sortRange: { range: { sheetId: 0, startRowIndex: 3, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 5 }, sortSpecs: [{ dimensionIndex: 3, sortOrder: "DESCENDING" }] } })]);
  g = await grid("Summary");
  check("sort a range Z→A by September", w.status === 200 && v(g, 3, 0) === "East" && v(g, 6, 0) === "West" && v(g, 3, 4) === "$70,660", JSON.stringify([w.json, [3, 4, 5, 6].map((r) => [v(g, r, 0), v(g, r, 3), v(g, r, 4)])]));
  w = await write([batch({ setBasicFilter: { filter: { range: { sheetId: 7001, startRowIndex: 0, endRowIndex: 12001, startColumnIndex: 0, endColumnIndex: 8 }, filterSpecs: [{ columnIndex: 2, filterCriteria: { hiddenValues: ["North"] } }] } } })]);
  const fg = await grid("Orders", 0, 9, 8);
  mm = await meta();
  check("a filter hides rows (hiddenByFilter → height 0)", w.status === 200 && fg.rowPx[1] === 0 && fg.rowPx[2] === 21 && mm.tabs[1].filter?.filterSpecs?.length === 1);
  w = await write([batch({ clearBasicFilter: { sheetId: 7001 } })]);
  check("remove the filter", (await meta()).tabs[1].filter === null && (await grid("Orders", 0, 3, 8)).rowPx[1] === 21);
  await write([{ t: "values", data: [{ range: "'Summary'!H1:H2", values: [["1"], ["2"]] }] }]);
  w = await write([batch({ autoFill: { useAlternateSeries: false, sourceAndDestination: { source: { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 7, endColumnIndex: 8 }, dimension: "ROWS", fillLength: 3 } } })]);
  g = await grid("Summary");
  check("fill handle: autoFill continues a series", w.status === 200 && v(g, 4, 7) === "5");
  w = await write([batch({ copyPaste: { source: { sheetId: 0, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 1, endColumnIndex: 2 }, destination: { sheetId: 0, startRowIndex: 8, endRowIndex: 9, startColumnIndex: 2, endColumnIndex: 3 }, pasteType: "PASTE_NORMAL" } })]);
  g = await grid("Summary");
  check("copyPaste adjusts relative formulas (=SUM(B4:B7) → =SUM(C5:C8))", w.status === 200 && g.rows[8][2]?.uv?.formulaValue === "=SUM(C5:C8)" && g.rows[8][2]?.uf?.numberFormat?.type === "CURRENCY");
  w = await write([batch({ cutPaste: { source: { sheetId: 0, startRowIndex: 11, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 1 }, destination: { sheetId: 7001, rowIndex: 0, columnIndex: 9 }, pasteType: "PASTE_NORMAL" } })]);
  check("cutPaste moves cells (even to another tab)", w.status === 200 && !v(await grid("Summary"), 11, 0) && S.formatted(sheetOf("Orders"), 0, 9).text.startsWith("This is a long note"));
  w = await write([batch({ findReplace: { find: "Shipped", replacement: "Delivered", matchCase: true, includeFormulas: false, sheetId: 7001 } })]);
  check("find and replace", w.status === 200 && (w.json.replies?.[0]?.replies?.[0]?.findReplace?.occurrencesChanged ?? 0) > 10000 && v(await grid("Orders", 1, 3, 8), 0, 7) === "Pending");

  // ── Undo (the editor sends the inverse: the old cells via updateCells) ──
  const oldCell = (await grid("Summary")).rows[3][0];
  await write([{ t: "values", data: [{ range: "'Summary'!A4", values: [["Changed"]] }] }]);
  w = await write([batch({ updateCells: { range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 }, rows: [{ values: [{ userEnteredValue: oldCell.uv }] }], fields: "userEnteredValue" } })]);
  check("undo puts the old value back (updateCells with fields)", w.status === 200 && v(await grid("Summary"), 3, 0) === oldCell.v);
  w = await write([batch({ updateCells: { range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 }, fields: "note" } })]);
  check("clearing a field with no rows (delete note)", w.status === 200 && !(await grid("Summary")).rows[3][0]?.note);

  // ── Tabs ──
  w = await write([batch({ addSheet: { properties: { sheetId: 555, title: "October", index: 2 } } })]);
  check("add a sheet with our own id", w.status === 200 && (await meta()).tabs.some((t: J) => t.sheetId === 555 && t.title === "October"));
  w = await write([batch({ updateSheetProperties: { properties: { sheetId: 555, title: "Oct 2026" }, fields: "title" } }, { updateSheetProperties: { properties: { sheetId: 555, tabColorStyle: { rgbColor: { red: 1 } } }, fields: "tabColorStyle" } })]);
  mm = await meta();
  check("rename and colour a sheet", mm.tabs.find((t: J) => t.sheetId === 555)?.title === "Oct 2026" && mm.tabs.find((t: J) => t.sheetId === 555)?.color?.red === 1);
  w = await write([batch({ updateSheetProperties: { properties: { sheetId: 0, title: "orders" }, fields: "title" } })]);
  check("a duplicate sheet name is refused", w.status === 400 && /already exists/.test(w.json.error ?? ""));
  w = await write([batch({ duplicateSheet: { sourceSheetId: 0, insertSheetIndex: 1, newSheetId: 556, newSheetName: "Copy of Summary" } })]);
  mm = await meta();
  check("duplicate a sheet", w.status === 200 && mm.tabs.map((t: J) => t.title).join() === "Summary,Copy of Summary,Orders,Oct 2026");
  w = await write([batch({ updateSheetProperties: { properties: { sheetId: 0, index: 2 }, fields: "index" } })]);
  check("move a sheet right (index counted before the move)", (await meta()).tabs.map((t: J) => t.title).join() === "Copy of Summary,Summary,Orders,Oct 2026");
  w = await write([batch({ deleteSheet: { sheetId: 556 } }, { deleteSheet: { sheetId: 555 } })]);
  check("delete sheets", w.status === 200 && (await meta()).tabs.length === 2);

  // ── Guards ──
  const callsBefore = mock.calls.length;
  w = await write([batch({ addProtectedRange: { protectedRange: { range: { sheetId: 0 } } } })]);
  check("requests the editor doesn't use are refused before reaching Google", w.status === 400 && /isn't allowed/.test(w.json.error ?? "") && !mock.calls.slice(callsBefore).some((c) => c.path.includes(":batchUpdate")));
  w = await write([{ t: "script", code: "x" }]);
  check("unknown change types are refused", w.status === 400);
  w = await call("/api/google/sheets/doc1", { action: "write", ops: [{ t: "values", data: [{ range: "A1", values: [["x"]] }] }] });
  check("writes to a document are refused", w.status === 400 && /isn't a Google Sheet/.test(w.json.error ?? ""));
  check("grid of a document is refused", (await call("/api/google/sheets/doc1?view=meta")).status === 400);
  const sm = (await call("/api/google/sheets/shared1?view=meta")).json;
  check("a file shared view-only opens read-only", sm.canEdit === false && sm.locale === "en_IN");
  w = await call("/api/google/sheets/shared1", { action: "write", ops: [{ t: "batch", requests: [{ repeatCell: { range: { sheetId: 0 }, cell: {}, fields: "userEnteredFormat" } }] }] });
  check("and Google's refusal to write comes back as a message", w.status === 400 && /permission/i.test(w.json.error ?? ""));

  // ── File: rename, star ──
  let f = await call(api, { action: "rename", name: "Q3 Sales 2026" });
  check("rename the spreadsheet from the title", f.status === 200 && mock.files[ID].name === "Q3 Sales 2026" && (await meta()).title === "Q3 Sales 2026");
  f = await call(api, { action: "star", starred: true });
  check("star it", f.status === 200 && mock.files[ID].starred === true && (await meta()).file.starred === true);

  // ── Existing features keep working ──
  const legacy = await call("/api/google", { action: "setCell", id: ID, tab: "Summary", row: 19, col: 0, value: "legacy" });
  check("the old setCell action still works", legacy.status === 200 && v(await grid("Summary", 0, 30), 19, 0) === "legacy");
  const vals = (await call(`/api/google?view=values&id=${ID}&range=Summary`)).json;
  check("Data values view still works", Array.isArray(vals.values) && vals.values[2]?.[0] === "Region");
  const live = await fetch(`${BASE}/api/live-sheet/no-such-project/${ID}`);
  check("/api/live-sheet still answers (unlinked → 404)", live.status === 404);

  // ── Read-only connection ──
  await db.googleConnection.update({ where: { userId: dev.id }, data: { scopes: "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly" } });
  const ro = (await call(`${api}?view=meta`)).json;
  check("a read-only connection opens view only", ro.canEdit === false && ro.connection?.canEdit === false);
  w = await write([{ t: "values", data: [{ range: "'Summary'!A1", values: [["x"]] }] }]);
  check("and writes ask to reconnect", w.status === 400 && w.json.reconnect === true);
  await db.googleConnection.deleteMany({ where: { userId: dev.id } });
  const none = await call(`${api}?view=meta`);
  check("not connected says so", none.status === 400 && none.json.connect === true);
} catch (e) {
  check("no unexpected error", false, String((e as Error).stack ?? e));
} finally {
  if (before) await db.googleConnection.upsert({ where: { userId: dev.id }, create: { userId: dev.id, email: before.email, refresh: before.refresh as Prisma.InputJsonValue, accessToken: before.accessToken, expiresAt: before.expiresAt, scopes: before.scopes }, update: { email: before.email, refresh: before.refresh as Prisma.InputJsonValue, accessToken: before.accessToken, expiresAt: before.expiresAt, scopes: before.scopes } });
  else await db.googleConnection.deleteMany({ where: { userId: dev.id } });
  await mock.close();
  await db.$disconnect();
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
