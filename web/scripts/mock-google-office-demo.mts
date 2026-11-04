/**
 * A local Google for trying the Docs and Slides editors (and Sheets) in a
 * browser: starts the mock (scripts/lib/google-sheets-mock.ts with
 * google-docs-mock.ts and google-slides-mock.ts) on 127.0.0.1:4799 with demo
 * files and connects the dev user to it. Nothing reaches the real Google.
 * When it stops (after --minutes, default 45, or Ctrl+C) the dev user's
 * Google connection is put back as it was.
 *   npx tsx scripts/mock-google-office-demo.mts [--minutes 45]
 * Then open http://localhost:3000/docs or /slides (or /docs/docdemo, /slides/slidedemo).
 */
import "dotenv/config";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { seal } from "../src/lib/secret-box";
import { demoBook, DOC_MIME, SLIDES_MIME, startGoogleMock } from "./lib/google-sheets-mock";
import { demoDoc, MockDoc, para } from "./lib/google-docs-mock";
import { demoDeck } from "./lib/google-slides-mock";

const minutes = Number(process.argv[process.argv.indexOf("--minutes") + 1]) || 45;
const sheet = demoBook("sheetdemo");
const doc = demoDoc("docdemo");
const memo = new MockDoc("docmemo", "Team memo", [...para("Team memo", { ps: { namedStyleType: "TITLE" } }), ...para("Short notes for the weekly meeting.")]);
const shared = new MockDoc("docshared", "Supplier terms (shared with me)", para("These terms are shared with you for viewing."));
const deck = demoDeck("slidedemo");
const mock = await startGoogleMock(4799, {
  files: [
    sheet.file,
    { id: "docdemo", name: doc.title, mimeType: DOC_MIME, modifiedTime: "2026-10-28T09:30:00Z", viewedByMeTime: "2026-10-29T08:10:00Z", starred: true, comments: [{ id: "c1", content: "Is the night shift still on request?", author: { displayName: "Asha Rao" }, quotedFileContent: { value: "Night shift on request" }, createdTime: "2026-10-27T10:00:00Z" }] },
    { id: "docmemo", name: "Team memo", mimeType: DOC_MIME, modifiedTime: "2026-10-20T09:30:00Z", viewedByMeTime: "2026-10-25T18:10:00Z" },
    { id: "docshared", name: "Supplier terms (shared with me)", mimeType: DOC_MIME, modifiedTime: "2026-09-01T10:00:00Z", ownedByMe: false, owner: "Asha Rao", canEdit: false },
    { id: "slidedemo", name: "Q3 business review (demo)", mimeType: SLIDES_MIME, modifiedTime: "2026-10-28T11:00:00Z", viewedByMeTime: "2026-10-29T09:00:00Z" },
  ],
  books: [sheet.book],
  docs: [doc, memo, shared],
  decks: [deck],
});

const dev = await db.user.findUniqueOrThrow({ where: { email: "dev@localhost" } });
const before = await db.googleConnection.findUnique({ where: { userId: dev.id } });
const conn = {
  email: "dev@gtest.dev",
  refresh: seal("google-refresh", "rt-dev") as unknown as Prisma.InputJsonValue,
  accessToken: null,
  expiresAt: null,
  scopes: "openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
};
await db.googleConnection.upsert({ where: { userId: dev.id }, create: { userId: dev.id, ...conn }, update: conn });
console.log(`Mock Google on 127.0.0.1:4799 for ${minutes} min. Open http://localhost:3000/docs or /slides`);

let done = false;
async function stop() {
  if (done) return;
  done = true;
  if (before) await db.googleConnection.update({ where: { userId: dev.id }, data: { email: before.email, refresh: before.refresh as Prisma.InputJsonValue, accessToken: before.accessToken, expiresAt: before.expiresAt, scopes: before.scopes } });
  else await db.googleConnection.deleteMany({ where: { userId: dev.id, email: "dev@gtest.dev" } });
  await mock.close();
  await db.$disconnect();
  console.log(`Stopped after ${mock.calls.length} Google calls; dev connection restored.`);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setTimeout(stop, minutes * 60_000);
