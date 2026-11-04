/**
 * Editing Google Docs, Sheets and Slides from the suite, against a mock of
 * Google's token endpoint, Drive and Sheets on 127.0.0.1:4799. Start the
 * server with FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token
 * FORGE_GOOGLE_API=http://127.0.0.1:4799, then:
 *   PROJECTS_ROOT=... npx tsx scripts/test-cycle41.mts <devToken> <test-users.json>
 */
import "dotenv/config";
import http from "node:http";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { seal } from "../src/lib/secret-box";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const DEV = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie: DEV } } : { method: "POST", headers: { cookie: DEV, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};

// ── Mock Google: Drive files and one spreadsheet with two tabs
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const DOC_MIME = "application/vnd.google-apps.document";
const files: Record<string, { name: string; mimeType: string; trashed?: boolean }> = { sh1: { name: "Stock", mimeType: SHEET_MIME }, doc1: { name: "Policy", mimeType: DOC_MIME } };
const grid: string[][] = [["Item", "Qty"], ["HR coil", "48"], ["CR sheet", "120"], ["MS plate", "36"]];
const tabs = [{ sheetId: 0, title: "Stock" }];
const calls: { method: string; path: string; body: any }[] = [];
let n = 0;
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  let raw = "";
  for await (const ch of req) raw += ch;
  const body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : null;
  const json = (v: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  if (u.pathname === "/token") return json({ access_token: "at-dev", expires_in: 3600 });
  if (req.headers.authorization !== "Bearer at-dev") return json({ error: { message: "Invalid Credentials" } }, 401);
  calls.push({ method: req.method!, path: decodeURIComponent(u.pathname + u.search), body });
  const file = (id: string) => ({ id, ...files[id], modifiedTime: new Date().toISOString(), webViewLink: `https://docs.google.com/x/${id}/edit`, owners: [{ displayName: "Dev" }] });
  // Drive
  if (u.pathname === "/drive/v3/files" && req.method === "GET") {
    const q = u.searchParams.get("q") ?? "";
    return json({ files: Object.keys(files).filter((id) => !files[id].trashed && q.includes(files[id].mimeType)).map(file) });
  }
  if (u.pathname === "/drive/v3/files" && req.method === "POST") {
    const id = `new${++n}`;
    files[id] = { name: body.name, mimeType: body.mimeType };
    return json(file(id));
  }
  let m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/copy)?$/);
  if (m && files[m[1]]) {
    if (m[2]) { const id = `copy${++n}`; files[id] = { ...files[m[1]], name: body.name }; return json(file(id)); }
    if (req.method === "PATCH") { Object.assign(files[m[1]], body); return json(file(m[1])); }
    return json(file(m[1]));
  }
  // Sheets
  m = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
  if (m && m[1] === "sh1") {
    const rest = decodeURIComponent(m[2]);
    if (rest === "" ) return json({ properties: { title: "Stock" }, sheets: tabs.map((t) => ({ properties: { ...t, gridProperties: { rowCount: 1000, columnCount: 26 } } })) });
    if (rest === ":batchUpdate") {
      const r = body.requests[0];
      if (r.deleteDimension) grid.splice(r.deleteDimension.range.startIndex, 1);
      if (r.addSheet) tabs.push({ sheetId: tabs.length, title: r.addSheet.properties.title });
      return json({});
    }
    const vm = rest.match(/^\/values\/(.+?)(:append)?$/);
    if (vm) {
      if (vm[2]) { grid.push(body.values[0]); return json({}); }
      if (req.method === "PUT") {
        const cm = vm[1].match(/!([A-Z]+)(\d+)$/)!;
        const col = cm[1].charCodeAt(0) - 65, row = Number(cm[2]) - 1;
        grid[row] = grid[row] ?? [];
        grid[row][col] = body.values[0][0];
        return json({});
      }
      return json({ range: "Stock!A1:Z1000", values: grid });
    }
  }
  json({ error: { message: `not mocked: ${req.method} ${u.pathname}` } }, 404);
});
await new Promise<void>((r) => mock.listen(4799, "127.0.0.1", () => r()));

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
  const st = (await call("/api/google?view=status")).json;
  check("a full connection is marked as able to edit", st.connection?.canEdit === true);

  const list = (await call("/api/google?view=files&kind=sheets")).json.files as { id: string; name: string }[];
  check("sheets are listed", list?.length === 1 && list[0].name === "Stock");

  const created = await call("/api/google", { action: "create", kind: "sheets", name: "Dispatch log" });
  check("a new spreadsheet can be created", created.status === 200 && files[created.json.file?.id]?.mimeType === SHEET_MIME && created.json.file.name === "Dispatch log");
  const renamed = await call("/api/google", { action: "rename", id: created.json.file.id, name: "Dispatch log 2026" });
  check("and renamed", renamed.json.file?.name === "Dispatch log 2026" && files[created.json.file.id].name === "Dispatch log 2026");
  const copied = await call("/api/google", { action: "copy", id: "doc1", name: "Copy of Policy" });
  check("documents can be copied", copied.status === 200 && Object.values(files).some((f) => f.name === "Copy of Policy"));
  const trashed = await call("/api/google", { action: "trash", id: created.json.file.id });
  check("deleting moves the file to Google's Trash, not a permanent delete", trashed.status === 200 && files[created.json.file.id].trashed === true && !calls.some((c) => c.method === "DELETE"));

  const cell = await call("/api/google", { action: "setCell", id: "sh1", tab: "Stock", row: 1, col: 1, value: "52" });
  check("a cell can be edited", cell.status === 200 && grid[1][1] === "52" && calls.some((c) => c.method === "PUT" && c.path.includes("'Stock'!B2") && c.path.includes("valueInputOption=USER_ENTERED")));
  const app = await call("/api/google", { action: "appendRow", id: "sh1", tab: "Stock", values: ["GI coil", "64"] });
  check("a row can be added", app.status === 200 && grid[grid.length - 1][0] === "GI coil");
  const del = await call("/api/google", { action: "deleteRow", id: "sh1", tab: "Stock", row: 2 });
  check("a row can be deleted", del.status === 200 && !grid.some((r) => r[0] === "CR sheet") && calls.some((c) => c.body?.requests?.[0]?.deleteDimension?.range?.startIndex === 2));
  const tab = await call("/api/google", { action: "addTab", id: "sh1", name: "October" });
  check("a tab can be added", tab.status === 200 && (await call("/api/google?view=tabs&id=sh1")).json.tabs?.includes("October"));
  check("the edited values read back", ((await call("/api/google?view=values&id=sh1")).json.values as string[][])?.[1]?.[1] === "52");
  check("sheet edits are refused on a document", (await call("/api/google", { action: "setCell", id: "doc1", tab: "x", row: 0, col: 0, value: "x" })).status === 400);

  await db.googleConnection.update({ where: { userId: dev.id }, data: { scopes: "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly" } });
  check("a read-only connection is told to reconnect for editing", (await call("/api/google?view=status")).json.connection?.canEdit === false);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (before) await db.googleConnection.update({ where: { userId: dev.id }, data: { email: before.email, refresh: before.refresh as Prisma.InputJsonValue, accessToken: before.accessToken, expiresAt: before.expiresAt, scopes: before.scopes } });
  else await db.googleConnection.deleteMany({ where: { userId: dev.id } });
  mock.close();
  await db.$disconnect();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
