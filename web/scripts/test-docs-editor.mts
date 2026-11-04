/**
 * The Docs editor's API (/api/google/docs/<id>) and its index model
 * (src/components/docs/model.ts) against the Google mock on 127.0.0.1:4799
 * (scripts/lib/google-sheets-mock.ts + google-docs-mock.ts). Start the server
 * with FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token
 * FORGE_GOOGLE_API=http://127.0.0.1:4799, then:
 *   npx tsx scripts/test-docs-editor.mts <devToken>
 * The dev user's Google connection is replaced for the run and put back after.
 */
import "dotenv/config";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { seal } from "../src/lib/secret-box";
import { DOC_MIME, SHEET_MIME, startGoogleMock } from "./lib/google-sheets-mock";
import { demoDoc, MockDoc, para } from "./lib/google-docs-mock";
import { applyReq, cellAt, checkDelete, diffRegion, fromGoogle, invert, rebase, textOf, type Flat, type Req } from "../src/components/docs/model";

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
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers, json: (type.includes("json") ? await r.json().catch(() => ({})) : {}) as J, raw: type.includes("json") ? "" : await r.text() };
};
const ID = "docdemo";
const api = `/api/google/docs/${ID}`;
const open = async () => (await call(`${api}?view=open`)).json;
const write = (requests: Req[], revisionId?: string | null) => call(api, { action: "write", requests, revisionId });
const sig = (f: Flat) => f.toks.map((t) => (t.k === "c" ? t.ch : t.k === "n" ? "Â¶" : `<${t.k}>`)).join("");
const clone = (f: Flat): Flat => ({ ...f, toks: f.toks.map((t) => ({ ...t })) as Flat["toks"], lists: { ...f.lists } });

const demo = demoDoc(ID);
const shared = new MockDoc("docshared", "Shared policy", para("Read me only."));
const mock = await startGoogleMock(4799, {
  files: [
    { id: ID, name: demo.title, mimeType: DOC_MIME, modifiedTime: "2026-10-28T10:00:00Z", viewedByMeTime: "2026-10-28T10:00:00Z", comments: [{ id: "c1", content: "Is this still right?", author: { displayName: "Asha Rao" }, quotedFileContent: { value: "Morning shift" }, resolved: false }] },
    { id: "docshared", name: "Shared policy", mimeType: DOC_MIME, modifiedTime: "2026-09-01T10:00:00Z", ownedByMe: false, owner: "Asha Rao", canEdit: false },
    { id: "sheet1", name: "A sheet", mimeType: SHEET_MIME, modifiedTime: "2026-09-02T10:00:00Z" },
  ],
  docs: [demo, shared],
});
const D = mock.docs[ID];

const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const before = await db.googleConnection.findUnique({ where: { userId: dev.id } });
const conn = (scopes: string) => ({ email: "dev@gtest.dev", refresh: seal("google-refresh", "rt-dev") as unknown as Prisma.InputJsonValue, accessToken: null, expiresAt: null, scopes });
const FULL = "openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";

try {
  await db.googleConnection.upsert({ where: { userId: dev.id }, create: { userId: dev.id, ...conn(FULL) }, update: conn(FULL) });

  // â”€â”€ Home â”€â”€
  const list = (await call("/api/google?view=files&kind=docs&order=opened")).json;
  check("home lists Google Docs only", list.files?.length === 2 && list.files.every((f: J) => f.webViewLink.includes("/document/")), JSON.stringify(list).slice(0, 300));
  const made = (await call("/api/google", { action: "create", kind: "docs", name: "Untitled document" })).json;
  check("Blank document creates a Google Doc that opens in the editor", !!made.file?.id && (await call(`/api/google/docs/${made.file.id}?view=open`)).json.doc?.body?.content?.length === 2);

  // â”€â”€ Opening â”€â”€
  const o = (await call(`${api}?view=open&touch=1`)).json;
  check("open: file, canEdit, document with a revision", o.file?.name === demo.title && o.canEdit === true && !!o.doc?.revisionId && o.connection?.canEdit === true);
  check("reads with suggestions inline (the indexes batchUpdate uses)", mock.calls.some((c) => c.path.includes("/v1/documents/docdemo?suggestionsViewMode=SUGGESTIONS_INLINE")));
  await new Promise((r) => setTimeout(r, 300));
  check("opening marks the file as opened", mock.calls.some((c) => c.method === "PATCH" && c.path.includes(ID) && c.body?.viewedByMeTime));
  let f = fromGoogle(o.doc);
  const last = o.doc.body.content[o.doc.body.content.length - 1].endIndex;
  check("model: one token per Google index, nothing it can't follow", f.toks.length === last && !f.unsafe, `${f.toks.length} vs ${last} ${f.unsafe}`);
  check("model: headings, lists, table, image, page break, footnote", f.toks.some((t) => t.k === "ts") && f.toks.some((t) => t.k === "io") && f.toks.some((t) => t.k === "pb") && f.toks.some((t) => t.k === "x" && t.what === "footnoteReference") && f.toks.some((t) => t.k === "n" && t.bullet?.listId === "kix.num"));
  check("model: suggestions are marked read only", f.toks.some((t) => t.k === "c" && t.sug === "i"));
  check("model: header and footer", (f.headers["kix.hdr"]?.length ?? 0) > 3 && (f.footers["kix.ftr"]?.length ?? 0) > 3 && f.docStyle.defaultHeaderId === "kix.hdr");
  check("model: text matches Google's", textOf(f.toks, 0, f.toks.length).includes("Plant operations handbook\nVersion 3"));

  // â”€â”€ Local simulation = Google's result â”€â”€
  const at = (s: string) => D.indexOf(s);
  const steps: (() => Req[])[] = [
    () => [{ insertText: { location: { index: at("Purpose") + 7 }, text: " of this handbook" } }],
    () => [{ insertText: { location: { index: at("Morning") }, text: "Note:\n" } }],
    () => [{ deleteContentRange: { range: { startIndex: at("Version 3") + 7, endIndex: at("Purpose") + 2 } } }],
    () => [{ updateTextStyle: { range: { startIndex: at("Daily"), endIndex: at("Daily") + 5 }, textStyle: { bold: true, foregroundColor: { color: { rgbColor: { red: 1 } } } }, fields: "bold,foregroundColor" } }],
    () => [{ updateParagraphStyle: { range: { startIndex: at("Contacts"), endIndex: at("Contacts") + 2 }, paragraphStyle: { namedStyleType: "HEADING_2", alignment: "CENTER" }, fields: "namedStyleType,alignment" } }],
    () => [{ insertText: { location: { index: at("Sign the") }, text: "\t" } }, { createParagraphBullets: { range: { startIndex: at("Check the"), endIndex: at("Sign the") + 3 }, bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN" } }],
    () => [{ deleteParagraphBullets: { range: { startIndex: at("Evening"), endIndex: at("Evening") + 2 } } }],
  ];
  let allSame = true;
  let firstBad = "";
  for (const step of steps) {
    const reqs = step();
    const local = clone(f);
    for (const r of reqs) applyReq(local, r);
    const w = await write(reqs, f.revisionId);
    if (w.status !== 200) {
      allSame = false;
      firstBad = `${JSON.stringify(reqs).slice(0, 120)} -> ${w.json.error}`;
      break;
    }
    const fresh = fromGoogle(w.json.doc);
    if (sig(local) !== sig(fresh) || fresh.unsafe) {
      allSame = false;
      firstBad = JSON.stringify(reqs).slice(0, 160);
    }
    f = fresh;
  }
  check("typing, newlines, deleting across paragraphs, styles and bullets: local copy = Google's copy", allSame, firstBad);
  const nested = f.toks.find((t) => t.k === "n" && t.bullet && (t.bullet.nestingLevel ?? 0) === 1 && textOf(f.toks, 0, f.toks.length).includes("Sign the"));
  check("a leading tab nests a list item (and Google removes the tab)", !!nested && !textOf(f.toks, 0, f.toks.length).includes("\tSign"));
  check("write sends writeControl.requiredRevisionId and gets the next revision", mock.calls.some((c) => c.path.endsWith(":batchUpdate") && c.body?.writeControl?.requiredRevisionId) && f.revisionId === D.revisionId);

  // â”€â”€ Undo by inverse requests â”€â”€
  {
    const s0 = at("Shifts");
    const e0 = at("Evening") + 4;
    const del: Req = { deleteContentRange: { range: { startIndex: s0, endIndex: e0 } } };
    const inv = invert(f, del)!;
    const beforeSig = sig(f);
    const beforeNs = JSON.stringify(f.toks.filter((t) => t.k === "n").map((t) => [(t as J).ps.namedStyleType, !!(t as J).bullet]));
    let w = await write([del], f.revisionId);
    w = await write(inv, w.json.revisionId);
    const back = fromGoogle(w.json.doc);
    check("undo of a deletion across paragraphs puts text, heading and bullets back", w.status === 200 && sig(back) === beforeSig && JSON.stringify(back.toks.filter((t) => t.k === "n").map((t) => [(t as J).ps.namedStyleType, !!(t as J).bullet])) === beforeNs, w.json.error);
    f = back;
    const st: Req = { updateTextStyle: { range: { startIndex: at("Ludhiana"), endIndex: at("Ludhiana") + 8 }, textStyle: { italic: true }, fields: "italic,bold" } };
    const inv2 = invert(f, st)!;
    w = await write([st], f.revisionId);
    w = await write(inv2, w.json.revisionId);
    f = fromGoogle(w.json.doc);
    const lud = f.toks[at("Ludhiana")] as J;
    check("undo of a style change restores the old style", lud.ts?.bold === true && !lud.ts?.italic);
  }

  // â”€â”€ Others' edits and conflicts â”€â”€
  {
    const mine: Req[] = [{ insertText: { location: { index: at("Record coil") }, text: "Mine: " } }];
    D.batch([{ insertText: { location: { index: at("Plant head") }, text: "Acting " } }]); // someone else, later in the document
    let w = await write(mine, f.revisionId);
    check("a write based on an old revision comes back as a conflict, with Google's copy", w.status === 200 && w.json.conflict === true && !!w.json.doc);
    const fresh = fromGoogle(w.json.doc);
    const moved = rebase(mine, diffRegion(f.toks, fresh.toks));
    w = await write(moved.reqs, fresh.revisionId);
    const t = D.text();
    check("our change is moved past theirs and saved: both are kept", w.status === 200 && !w.json.conflict && moved.dropped === 0 && t.includes("Mine: Record coil") && t.includes("Acting Plant head"));
    f = fromGoogle(w.json.doc);
    // Same spot: theirs wins, ours is dropped.
    const p = at("Sign the");
    D.batch([{ deleteContentRange: { range: { startIndex: p, endIndex: p + 8 } } }]);
    const r2 = rebase([{ insertText: { location: { index: p + 3 }, text: "X" } }], diffRegion(f.toks, fromGoogle(D.get()).toks));
    check("a change inside the part someone else changed is dropped, not misplaced", r2.dropped === 1 && r2.reqs.length === 0);
    f = fromGoogle(D.get());
  }

  // â”€â”€ Structural: tables, images, page breaks, replace all â”€â”€
  {
    const i = at("Text in ");
    let w = await write([{ insertTable: { rows: 2, columns: 3, location: { index: i } } }], f.revisionId);
    f = fromGoogle(w.json.doc);
    const tStart = f.toks.findIndex((t, k) => t.k === "ts" && k > i - 2);
    check("insertTable: a table after a new line, cells mapped", w.status === 200 && !f.unsafe && tStart === i + 1 && cellAt(f.toks, tStart + 3)?.row === 0 && cellAt(f.toks, tStart + 3)?.col === 0);
    const c01 = tStart + 5;
    w = await write([{ insertText: { location: { index: tStart + 3 }, text: "Item" } }], f.revisionId);
    f = fromGoogle(w.json.doc);
    check("type in a table cell", w.status === 200 && w.json.doc.body.content.find((e: J) => e.table && e.startIndex === tStart)?.table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content === "Item\n");
    check("model refuses deleting part of a table, or a cell's last newline", typeof checkDelete(f.toks, tStart - 2, tStart + 4) === "string" && typeof checkDelete(f.toks, tStart + 3, tStart + 8) === "string" && c01 > 0);
    w = await write([{ deleteContentRange: { range: { startIndex: tStart + 1, endIndex: tStart + 9 } } }], f.revisionId);
    check("Google's own check refuses a partial table deletion too", w.status === 400 && /table|cell|range/i.test(w.json.error ?? ""));
    w = await write([{ insertTableRow: { tableCellLocation: { tableStartLocation: { index: tStart }, rowIndex: 0, columnIndex: 0 }, insertBelow: true } }], f.revisionId);
    f = fromGoogle(w.json.doc);
    check("insert a table row", w.json.doc.body.content.find((e: J) => e.table && e.startIndex === tStart)?.table.rows === 3 && !f.unsafe);
    w = await write([{ deleteTableColumn: { tableCellLocation: { tableStartLocation: { index: tStart }, rowIndex: 0, columnIndex: 2 } } }], f.revisionId);
    f = fromGoogle(w.json.doc);
    check("delete a table column", w.json.doc.body.content.find((e: J) => e.table && e.startIndex === tStart)?.table.columns === 2 && !f.unsafe);
    const ip = at("Last reviewed");
    w = await write([{ insertInlineImage: { location: { index: ip }, uri: "https://example.com/chart.png", objectSize: { width: { magnitude: 200, unit: "PT" } } } }], f.revisionId);
    f = fromGoogle(w.json.doc);
    check("insert an image (by URL)", w.status === 200 && f.toks[ip]?.k === "io" && !!w.json.replies?.[0]?.insertInlineImage?.objectId);
    w = await write([{ insertPageBreak: { location: { index: ip } } }], f.revisionId);
    f = fromGoogle(w.json.doc);
    check("insert a page break (break + newline)", f.toks[ip]?.k === "pb" && f.toks[ip + 1]?.k === "n");
    w = await write([{ replaceAllText: { containsText: { text: "shift", matchCase: false }, replaceText: "SHIFT" } }], f.revisionId);
    f = fromGoogle(w.json.doc);
    check("find and replace all (replaceAllText)", w.json.replies?.[0]?.replaceAllText?.occurrencesChanged >= 2 && D.text().includes("Morning SHIFT"));
    w = await write([{ createHeader: { type: "DEFAULT" } } as Req], f.revisionId);
    check("requests outside the editor's list are refused", w.status === 400 && /isn't allowed/.test(w.json.error ?? ""));
  }

  // â”€â”€ Drive: export, comments, rename, star, image upload â”€â”€
  {
    const pdf = await call(`${api}?view=export&format=pdf&name=Handbook`);
    check("download as PDF (Drive export)", pdf.status === 200 && pdf.raw.startsWith("%PDF") && /Handbook\.pdf/.test(pdf.headers.get("content-disposition") ?? ""));
    const docx = await call(`${api}?view=export&format=docx`);
    check("download as DOCX", docx.status === 200 && docx.raw.startsWith("PK") && mock.calls.some((c) => c.path.includes("/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document")));
    const pr = await call(`${api}?view=export&format=pdf&inline=1`);
    check("print opens the PDF inline", (pr.headers.get("content-disposition") ?? "").startsWith("inline"));
    check("comments are listed (read only)", (await call(`${api}?view=comments`)).json.comments?.[0]?.author?.displayName === "Asha Rao");
    const rn = await call(api, { action: "rename", name: "Handbook v3" });
    check("rename from the title", rn.json.file?.name === "Handbook v3" && D.title === "Handbook v3");
    const stt = await call(api, { action: "star", starred: true });
    check("star", stt.json.file?.starred === true);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), "logo.png");
    const up = await fetch(`${BASE}${api}`, { method: "POST", headers: { cookie: DEV }, body: form }).then((r) => r.json());
    const permsBefore = Object.keys(mock.perms).length;
    check("upload an image to Drive, shared by link while it's inserted", /^https:\/\/drive\.google\.com\/uc\?export=download&id=img/.test(up.uri ?? "") && permsBefore === 1, JSON.stringify(up));
    f = fromGoogle((await open()).doc);
    const w = await write([{ insertInlineImage: { location: { index: 1 }, uri: up.uri } }], f.revisionId);
    await new Promise((r) => setTimeout(r, 300));
    check("after inserting, the image is private again", w.status === 200 && Object.keys(mock.perms).length === 0);
    const bad = new FormData();
    bad.append("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
    const br = await fetch(`${BASE}${api}`, { method: "POST", headers: { cookie: DEV }, body: bad });
    check("only PNG, JPEG or GIF uploads", br.status === 400);
  }

  // â”€â”€ View only, wrong file, read-only connection â”€â”€
  {
    const sh = (await call("/api/google/docs/docshared?view=open")).json;
    check("a doc shared for viewing opens view only", sh.canEdit === false && !!sh.doc);
    const w = await call("/api/google/docs/docshared", { action: "write", requests: [{ insertText: { location: { index: 1 }, text: "x" } }], revisionId: sh.doc.revisionId });
    check("and Google refuses writes to it", w.status === 400 && shared.text().startsWith("Read me"));
    const notDoc = await call("/api/google/docs/sheet1?view=open");
    check("a spreadsheet can't be opened as a doc", notDoc.status === 400 && /isn't a Google Doc/.test(notDoc.json.error ?? ""));
    await db.googleConnection.update({ where: { userId: dev.id }, data: { scopes: "openid email https://www.googleapis.com/auth/drive.readonly" } });
    const ro = (await call(`${api}?view=open`)).json;
    const wr = await write([{ insertText: { location: { index: 1 }, text: "x" } }], ro.doc?.revisionId);
    check("a read-only connection reads but can't write (Reconnect)", ro.canEdit === false && ro.connection?.canEdit === false && wr.status === 400 && wr.json.reconnect === true);
    await db.googleConnection.update({ where: { userId: dev.id }, data: { scopes: FULL } });
    await db.googleConnection.deleteMany({ where: { userId: dev.id } });
    const nc = await call(`${api}?view=open`);
    check("not connected: the editor offers Connect", nc.status === 400 && nc.json.connect === true);
    await db.googleConnection.create({ data: { userId: dev.id, ...conn(FULL) } });
  }
} catch (e) {
  check("no crash", false, (e as Error).stack ?? String(e));
} finally {
  if (before) await db.googleConnection.upsert({ where: { userId: dev.id }, create: { userId: dev.id, email: before.email, refresh: before.refresh as Prisma.InputJsonValue, accessToken: before.accessToken, expiresAt: before.expiresAt, scopes: before.scopes }, update: { email: before.email, refresh: before.refresh as Prisma.InputJsonValue, accessToken: before.accessToken, expiresAt: before.expiresAt, scopes: before.scopes } });
  else await db.googleConnection.deleteMany({ where: { userId: dev.id } });
  await mock.close();
  await db.$disconnect();
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
