/**
 * A local Google for trying the Sheets editor in a browser: starts the mock
 * (scripts/lib/google-sheets-mock.mts) on 127.0.0.1:4799 with a demo
 * spreadsheet and connects the dev user to it. Nothing reaches the real
 * Google. When it stops (after --minutes, default 45, or Ctrl+C) the dev
 * user's Google connection is put back as it was.
 *   npx tsx scripts/mock-google-sheets-demo.mts [--minutes 45]
 */
import "dotenv/config";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { seal } from "../src/lib/secret-box";
import { demoBook, newSheet, SHEET_MIME, startGoogleMock } from "./lib/google-sheets-mock";

const minutes = Number(process.argv[process.argv.indexOf("--minutes") + 1]) || 45;
const demo = demoBook("sheetdemo");
const budget = { id: "budget1", title: "Household budget", locale: "en_US", sheets: [newSheet(0, "Sheet1", 0, 200, 12)] };
budget.sheets[0].cells = [
  [{ userEnteredValue: { stringValue: "Item" }, userEnteredFormat: { textFormat: { bold: true } } }, { userEnteredValue: { stringValue: "Amount" }, userEnteredFormat: { textFormat: { bold: true } } }],
  [{ userEnteredValue: { stringValue: "Rent" } }, { userEnteredValue: { numberValue: 1200 } }],
  [{ userEnteredValue: { stringValue: "Food" } }, { userEnteredValue: { numberValue: 430 } }],
];
const mock = await startGoogleMock(4799, {
  files: [
    demo.file,
    { id: "budget1", name: "Household budget", mimeType: SHEET_MIME, modifiedTime: "2026-10-20T09:30:00Z", viewedByMeTime: "2026-10-27T18:10:00Z", starred: true },
    { id: "shared1", name: "Price list (shared with me)", mimeType: SHEET_MIME, modifiedTime: "2026-09-01T10:00:00Z", ownedByMe: false, owner: "Asha Rao", canEdit: false },
  ],
  books: [demo.book, budget, { id: "shared1", title: "Price list", locale: "en_IN", sheets: [newSheet(0, "Sheet1", 0, 100, 10)] }],
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
console.log(`Mock Google on 127.0.0.1:4799 for ${minutes} min. Open http://localhost:3000/sheets`);

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
