/**
 * The Slides editor's API (/api/google/slides/<id>) and its local model
 * (src/components/slides/model.ts) against the Google mock on 127.0.0.1:4799
 * (scripts/lib/google-sheets-mock.ts + google-slides-mock.ts). Start the
 * server with FORGE_GOOGLE_TOKEN_URL=http://127.0.0.1:4799/token
 * FORGE_GOOGLE_API=http://127.0.0.1:4799, then:
 *   npx tsx scripts/test-slides-editor.mts <devToken>
 * The dev user's Google connection is replaced for the run and put back after.
 */
import "dotenv/config";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { seal } from "../src/lib/secret-box";
import { SLIDES_MIME, startGoogleMock } from "./lib/google-sheets-mock";
import { demoDeck, MockDeck } from "./lib/google-slides-mock";
import { applyReq, findEl, invert, plainOf, slideHash, toFlat, touches, type Req } from "../src/components/slides/model";

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
const call = async (p: string, body?: unknown, redirect: RequestRedirect = "follow") => {
  const r = await fetch(`${BASE}${p}`, body === undefined ? { headers: { cookie: DEV }, redirect } : { method: "POST", headers: { cookie: DEV, "content-type": "application/json" }, body: JSON.stringify(body) });
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers, json: (type.includes("json") ? await r.json().catch(() => ({})) : {}) as J, raw: type.includes("json") ? "" : await r.text().catch(() => "") };
};
const ID = "slidedemo";
const api = `/api/google/slides/${ID}`;
const write = (requests: Req[], revisionId?: string | null) => call(api, { action: "write", requests, revisionId });
/** What matters on screen: slide order, and each element's place, size and text with styles. */
const norm = (p: J) =>
  JSON.stringify(
    (p.slides ?? []).map((s: J) => [
      s.objectId,
      (s.pageElements ?? []).map((e: J) => [e.objectId, e.transform?.translateX, e.transform?.translateY, e.transform?.scaleX, e.shape?.shapeType, JSON.stringify(e.shape?.shapeProperties?.shapeBackgroundFill ?? null), toFlat(e.shape?.text).chars.map((c) => c.ch + JSON.stringify(c.st)).join(""), JSON.stringify(toFlat(e.shape?.text).paras)]),
      plainOf(s.slideProperties?.notesPage?.pageElements?.[0]?.shape?.text),
    ]),
  );

const demo = demoDeck(ID);
const shared = new MockDeck("deckshared", "Shared deck");
shared.batch([{ createSlide: { objectId: "s_only", slideLayoutReference: { predefinedLayout: "TITLE" } } }]);
const mock = await startGoogleMock(4799, {
  files: [
    { id: ID, name: "Q3 business review (demo)", mimeType: SLIDES_MIME, modifiedTime: "2026-10-28T10:00:00Z", viewedByMeTime: "2026-10-28T10:00:00Z" },
    { id: "deckshared", name: "Shared deck", mimeType: SLIDES_MIME, modifiedTime: "2026-09-01T10:00:00Z", ownedByMe: false, owner: "Asha Rao", canEdit: false },
  ],
  decks: [demo, shared],
});
const M = mock.decks[ID];

const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const before = await db.googleConnection.findUnique({ where: { userId: dev.id } });
const FULL = "openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";
const conn = (scopes: string) => ({ email: "dev@gtest.dev", refresh: seal("google-refresh", "rt-dev") as unknown as Prisma.InputJsonValue, accessToken: null, expiresAt: null, scopes });

try {
  await db.googleConnection.upsert({ where: { userId: dev.id }, create: { userId: dev.id, ...conn(FULL) }, update: conn(FULL) });

  const list = (await call("/api/google?view=files&kind=slides")).json;
  check("home lists presentations", list.files?.length === 2 && list.files.every((f: J) => f.webViewLink.includes("/presentation/")));
  const made = (await call("/api/google", { action: "create", kind: "slides", name: "Untitled presentation" })).json;
  check("Blank presentation creates one that opens with a title slide", (await call(`/api/google/slides/${made.file?.id}?view=open`)).json.pres?.slides?.length === 1);

  const o = (await call(`${api}?view=open&touch=1`)).json;
  let p = o.pres;
  check("open: file, canEdit, slides, layouts and masters", o.canEdit === true && p.slides.length === 5 && p.layouts.length === 4 && p.masters.length === 1 && !!p.revisionId);
  check("placeholders point at their layout (for inherited styles)", p.slides[0].pageElements.every((e: J) => e.shape?.placeholder?.parentObjectId?.startsWith("l_title")));
  check("speaker notes come with each slide", plainOf(findEl(p, p.slides[0].slideProperties.notesPage.notesProperties.speakerNotesObjectId)?.el.shape.text) === "Welcome everyone. Keep this under ten minutes.");

  // ── Thumbnails: redirect to Google's picture, cached per slide version ──
  const v = slideHash(p.slides[0]);
  const t1 = await call(`${api}?view=thumb&page=s_title&size=MEDIUM&v=${v}`, undefined, "manual");
  const calls1 = M.thumbCalls;
  const t2 = await call(`${api}?view=thumb&page=s_title&size=MEDIUM&v=${v}`, undefined, "manual");
  check("a slide picture is a redirect to getThumbnail's contentUrl", t1.status === 302 && /\/thumb\/slidedemo\/s_title\.svg/.test(t1.headers.get("location") ?? ""));
  check("the same slide version isn't fetched from Google twice", t2.status === 302 && M.thumbCalls === calls1 && calls1 === 1);
  await call(`${api}?view=thumb&page=s_title&size=LARGE&v=${v}`, undefined, "manual");
  check("a large picture for presenting is its own request", M.thumbCalls === 2 && mock.calls.some((c) => c.path.includes("thumbnailProperties.thumbnailSize=LARGE")));

  // ── Local changes = Google's result ──
  const steps: (() => Req[])[] = [
    () => [{ insertText: { objectId: "s_agenda_body", insertionIndex: 5, text: " totals" } }],
    () => [{ insertText: { objectId: "s_agenda_body", insertionIndex: 0, text: "Welcome\n" } }],
    () => [{ deleteText: { objectId: "s_agenda_body", textRange: { type: "FIXED_RANGE", startIndex: 3, endIndex: 12 } } }],
    () => [{ updateTextStyle: { objectId: "s_agenda_title", textRange: { type: "ALL" }, style: { bold: true, fontSize: { magnitude: 40, unit: "PT" } }, fields: "bold,fontSize" } }],
    () => [{ updateParagraphStyle: { objectId: "s_agenda_title", textRange: { type: "ALL" }, style: { alignment: "CENTER" }, fields: "alignment" } }],
    () => [{ updatePageElementTransform: { objectId: "g_box_order", applyMode: "ABSOLUTE", transform: { scaleX: 1.5, scaleY: 1, shearX: 0, shearY: 0, translateX: 400000, translateY: 1700000, unit: "EMU" } } }],
    () => [{ updateShapeProperties: { objectId: "g_box_order", shapeProperties: { shapeBackgroundFill: { propertyState: "RENDERED", solidFill: { color: { rgbColor: { red: 1, green: 0.8, blue: 0 } } } } }, fields: "shapeBackgroundFill.solidFill.color,shapeBackgroundFill.propertyState" } }],
    () => [{ createShape: { objectId: "g_new_box1", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "s_shapes", size: { width: { magnitude: 3000000, unit: "EMU" }, height: { magnitude: 500000, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 100000, translateY: 100000, unit: "EMU" } } } }, { insertText: { objectId: "g_new_box1", insertionIndex: 0, text: "Hello" } }],
    () => [{ createLine: { objectId: "g_new_line1", lineCategory: "STRAIGHT", elementProperties: { pageObjectId: "s_shapes", size: { width: { magnitude: 2000000, unit: "EMU" }, height: { magnitude: 0, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU" } } } }],
    () => [{ updateSlidesPosition: { slideObjectIds: ["s_thanks"], insertionIndex: 1 } }],
    () => [{ insertText: { objectId: "s_agenda_notes", insertionIndex: 4, text: " main" } }],
    () => [{ deleteObject: { objectId: "g_arrow_1" } }],
  ];
  let same = true;
  let bad = "";
  for (const step of steps) {
    const reqs = step();
    const local = JSON.parse(JSON.stringify(p));
    for (const r of reqs) applyReq(local, r);
    const w = await write(reqs, p.revisionId);
    if (w.status !== 200 || w.json.conflict) {
      same = false;
      bad = `${JSON.stringify(reqs).slice(0, 100)} -> ${w.json.error}`;
      break;
    }
    if (norm(local) !== norm(w.json.pres)) (same = false), (bad ||= JSON.stringify(reqs).slice(0, 140));
    p = w.json.pres;
  }
  check("text, styles, move and resize, fill, new text box and line, slide order, notes, delete: local copy = Google's", same, bad);
  check("each write is based on the revision it was made on", mock.calls.some((c) => c.path.endsWith(":batchUpdate") && c.body?.writeControl?.requiredRevisionId) && p.revisionId === M.revisionId);
  check("slide moved to second place", p.slides[1].objectId === "s_thanks");

  // ── Undo by inverse requests ──
  {
    const del: Req = { deleteObject: { objectId: "g_box_make" } };
    const inv = invert(p, del);
    const was = norm(p);
    let w = await write([del], p.revisionId);
    w = await write(inv ?? [], w.json.pres.revisionId);
    p = w.json.pres;
    const back = findEl(p, "g_box_make")?.el;
    check("undo of deleting a shape puts it back with its text and fill", !!inv && w.status === 200 && back?.shape?.shapeType === "ELLIPSE" && plainOf(back.shape.text) === "Make" && norm(p).length === was.length, w.json.error);
    const mv: Req = { updateSlidesPosition: { slideObjectIds: ["s_thanks"], insertionIndex: 5 } };
    const inv2 = invert(p, mv)!;
    w = await write([mv], p.revisionId);
    const after = w.json.pres.slides.map((s: J) => s.objectId);
    w = await write(inv2, w.json.pres.revisionId);
    p = w.json.pres;
    check("moving a slide and undoing it", after[4] === "s_thanks" && p.slides[1].objectId === "s_thanks");
    const ed: Req = { deleteText: { objectId: "s_title_centered_title", textRange: { type: "FIXED_RANGE", startIndex: 0, endIndex: 3 } } };
    const inv3 = invert(p, ed)!;
    w = await write([ed], p.revisionId);
    w = await write(inv3, w.json.pres.revisionId);
    p = w.json.pres;
    const tt = toFlat(findEl(p, "s_title_centered_title")!.el.shape.text);
    check("undo of deleting text restores it, bold included", tt.chars.map((c) => c.ch).join("").startsWith("Q3 business") && tt.chars[0].st.bold === true);
  }

  // ── Structural: new slides from layouts, copies, images, tables ──
  {
    let w = await write([{ createSlide: { objectId: "s_new_one", insertionIndex: 2, slideLayoutReference: { layoutId: "l_tb" } } }], p.revisionId);
    p = w.json.pres;
    const ns = p.slides[2];
    check("a new slide from a layout gets the layout's placeholders and a notes box", ns?.objectId === "s_new_one" && ns.pageElements.length === 2 && ns.pageElements[0].shape.placeholder.parentObjectId === "l_tb_title" && !!ns.slideProperties.notesPage.notesProperties.speakerNotesObjectId);
    w = await write([{ duplicateObject: { objectId: "s_agenda", objectIds: { s_agenda: "s_agenda_copy" } } }], p.revisionId);
    p = w.json.pres;
    const ci = p.slides.findIndex((s: J) => s.objectId === "s_agenda_copy");
    check("duplicate a slide (with the id we chose), right after it", ci > 0 && p.slides[ci - 1].objectId === "s_agenda" && plainOf(findEl(p, p.slides[ci].pageElements[1].objectId)?.el.shape.text) === plainOf(findEl(p, "s_agenda_body")?.el.shape.text));
    w = await write([{ createImage: { objectId: "g_img_new1", url: "https://example.com/x.png", elementProperties: { pageObjectId: "s_new_one" } } }], p.revisionId);
    p = w.json.pres;
    check("insert an image", !!findEl(p, "g_img_new1")?.el.image?.contentUrl);
    w = await write([{ createTable: { objectId: "g_tbl_new1", rows: 2, columns: 2, elementProperties: { pageObjectId: "s_new_one" } } }, { insertText: { objectId: "g_tbl_new1", cellLocation: { rowIndex: 1, columnIndex: 1 }, insertionIndex: 0, text: "42" } }], p.revisionId);
    p = w.json.pres;
    check("insert a table and type in a cell", plainOf(findEl(p, "g_tbl_new1")?.el.table.tableRows[1].tableCells[1].text) === "42");
    w = await write([{ deleteObject: { objectId: "s_new_one" } }], p.revisionId);
    p = w.json.pres;
    check("delete a slide", !p.slides.some((s: J) => s.objectId === "s_new_one"));
    w = await write([{ createSheetsChart: {} } as Req], p.revisionId);
    check("requests outside the editor's list are refused", w.status === 400 && /isn't allowed/.test(w.json.error ?? ""));
  }

  // ── Others' edits ──
  {
    M.batch([{ insertText: { objectId: "s_thanks_title", insertionIndex: 0, text: "Big " } }]);
    const mine: Req[] = [{ insertText: { objectId: "g_note_box", insertionIndex: 0, text: "Note: " } }];
    let w = await write(mine, p.revisionId);
    check("a write on an old revision comes back as a conflict, with Google's copy", w.json.conflict === true && !!w.json.pres);
    const fresh = w.json.pres;
    const changed = (oid: string) => JSON.stringify(findEl(p, oid)?.el) !== JSON.stringify(findEl(fresh, oid)?.el);
    const keep = mine.filter((r) => touches(r).every((x) => !changed(x)));
    w = await write(keep, fresh.revisionId);
    p = w.json.pres;
    check("our change to another object is sent again and both are kept", keep.length === 1 && plainOf(findEl(p, "g_note_box")?.el.shape.text).startsWith("Note: ") && plainOf(findEl(p, "s_thanks_title")?.el.shape.text) === "Big Thank you");
    M.batch([{ insertText: { objectId: "g_note_box", insertionIndex: 0, text: "X" } }]);
    const fresh2 = M.get();
    check("a change to the same object someone else changed is dropped", [{ insertText: { objectId: "g_note_box", insertionIndex: 2, text: "Y" } }].filter((r) => touches(r).every((x) => JSON.stringify(findEl(p, x)?.el) === JSON.stringify(findEl(fresh2, x)?.el))).length === 0);
    p = fresh2;
  }

  // ── Drive, view only, connection ──
  {
    const pptx = await call(`${api}?view=export&format=pptx&name=Review`);
    check("download as PPTX (Drive export)", pptx.status === 200 && pptx.raw.startsWith("PK") && /Review\.pptx/.test(pptx.headers.get("content-disposition") ?? ""));
    check("download as PDF", (await call(`${api}?view=export&format=pdf`)).raw.startsWith("%PDF"));
    check("rename", (await call(api, { action: "rename", name: "Q3 review" })).json.file?.name === "Q3 review" && M.p.title === "Q3 review");
    const sh = (await call("/api/google/slides/deckshared?view=open")).json;
    const w = await call("/api/google/slides/deckshared", { action: "write", requests: [{ deleteObject: { objectId: "s_only" } }], revisionId: sh.pres?.revisionId });
    check("a presentation shared for viewing opens view only, and writes are refused", sh.canEdit === false && w.status === 400);
    await db.googleConnection.update({ where: { userId: dev.id }, data: { scopes: "openid email https://www.googleapis.com/auth/drive.readonly" } });
    const ro = (await call(`${api}?view=open`)).json;
    const wr = await write([{ deleteObject: { objectId: "g_line_1" } }], ro.pres?.revisionId);
    check("a read-only connection views but asks to reconnect to edit", ro.canEdit === false && wr.json.reconnect === true);
    await db.googleConnection.update({ where: { userId: dev.id }, data: { scopes: FULL } });
  }

  // ── Google's thumbnail quota: limited per person ──
  {
    let limited = 0;
    for (let k = 0; k < 45; k++) if ((await call(`${api}?view=thumb&page=s_agenda&size=SMALL&v=q${k}`, undefined, "manual")).status === 429) limited++;
    check("slide pictures are rate limited (getThumbnail is an expensive read)", limited > 0 && M.thumbCalls <= 42, `${limited} limited, ${M.thumbCalls} calls`);
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
