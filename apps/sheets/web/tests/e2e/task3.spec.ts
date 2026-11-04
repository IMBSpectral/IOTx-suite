import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

type Sheets = { engine: { viewport: Function; editText: Function; info: Function } };

async function cell(page: Page, ref: string): Promise<{ text?: string; edit: string }> {
  return page.evaluate(async (ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(m[2]) - 1;
    const { engine } = (window as unknown as { sheets: Sheets }).sheets;
    const vp = await engine.viewport(row, col, row, col);
    return { text: vp.cells[0]?.[2], edit: await engine.editText(row, col) };
  }, ref);
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready");
}

async function goTo(page: Page, ref: string): Promise<void> {
  await page.getByTestId("namebox").fill(ref);
  await page.getByTestId("namebox").press("Enter");
}

async function typeAt(page: Page, ref: string, value: string): Promise<void> {
  await goTo(page, ref);
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

// The OS clipboard is shared by every browser on the machine: these run one at a time.
test.describe("clipboard", () => {
  test.describe.configure({ mode: "serial" });
  // Repeats and other workers can still run in parallel: hold a machine-wide lock (an atomic mkdir).
  const lock = join(tmpdir(), "spectral-sheets-clipboard.lock");
  test.beforeEach(async () => {
    for (let i = 0; ; i++) {
      try {
        mkdirSync(lock);
        return;
      } catch {
        if (i > 600) rmSync(lock, { recursive: true, force: true }); // stale after ~60s
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
  test.afterEach(() => rmSync(lock, { recursive: true, force: true }));

  test("copy and paste inside the app shifts relative formulas", async ({ page }) => {
    await open(page);
    await typeAt(page, "A1", "5");
    await typeAt(page, "A2", "=A1*2");
    await goTo(page, "A1:A2");
    await page.keyboard.press("Control+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^5\r?\n10/);
    await goTo(page, "C1");
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await cell(page, "C2")).edit).toBe("=C1*2");
    expect((await cell(page, "C2")).text).toBe("10");
  });

  test("cut and paste moves cells", async ({ page }) => {
    await open(page);
    await typeAt(page, "B1", "move me");
    await goTo(page, "B1");
    await page.keyboard.press("Control+x");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^move me/);
    await goTo(page, "D4");
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await cell(page, "D4")).text).toBe("move me");
    await expect.poll(async () => (await cell(page, "B1")).text).toBeUndefined();
  });

  test("text from another app pastes as typed values, and is one undo step", async ({ page }) => {
    await open(page);
    await page.evaluate(() => navigator.clipboard.writeText("Item\tQty\nPens\t4\nInk\t=2+3\n"));
    await goTo(page, "B2");
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await cell(page, "C4")).text).toBe("5");
    expect((await cell(page, "B3")).text).toBe("Pens");
    expect((await cell(page, "C3")).text).toBe("4");
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await cell(page, "B2")).text).toBeUndefined();
    expect((await cell(page, "C4")).text).toBeUndefined();
  });
});

test("dragging a column header border resizes the column in the engine", async ({ page }) => {
  await open(page);
  const grid = page.getByTestId("grid");
  const box = (await grid.boundingBox())!;
  // Border between A and B: x = 46 + 64.
  const x = box.x + 46 + 64;
  const y = box.y + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(async () => (await (window as unknown as { sheets: Sheets }).sheets.engine.viewport(0, 0, 0, 0)).col_widths[0]))
    .toBe(124);
  // Clicking where B used to start (x=46+70) now lands in A.
  await grid.click({ position: { x: 46 + 70, y: 24 + 10 } });
  await expect(page.getByTestId("namebox")).toHaveValue("A1");
});

test("work survives a reload (autosave to IndexedDB)", async ({ page }) => {
  await open(page);
  await page.getByTestId("title").fill("Budget 2027");
  await page.getByTestId("title").press("Enter");
  await typeAt(page, "A1", "rent");
  await typeAt(page, "B1", "=40*30");
  await expect.poll(async () => (await cell(page, "B1")).text).toBe("1200");
  // The edit has landed, so the status can't be a stale "Saved" from before it.
  await expect(page.getByTestId("status")).toHaveText("Saved in this browser");
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText("Ready");
  await expect(page.getByTestId("title")).toHaveValue("Budget 2027");
  await expect.poll(async () => (await cell(page, "B1")).text).toBe("1200");
  expect((await cell(page, "B1")).edit).toBe("=40*30");
});

test("download produces an xlsx that opens back with formulas", async ({ page }, info) => {
  await open(page);
  await typeAt(page, "A1", "7");
  await typeAt(page, "A2", "=A1*6");
  await page.getByTestId("title").fill("Answer");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download").click()]);
  expect(download.suggestedFilename()).toBe("Answer.xlsx");
  const path = info.outputPath("Answer.xlsx");
  await download.saveAs(path);
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 2).toString()).toBe("PK"); // a zip container

  // Open it in a fresh page.
  const page2 = await page.context().newPage();
  await page2.goto("/");
  await expect(page2.getByTestId("status")).not.toHaveText("");
  await page2.getByTestId("open-file").setInputFiles(path);
  await expect(page2.getByTestId("status")).toHaveText(/Opened Answer\.xlsx|Saved in this browser/);
  await expect.poll(async () => (await cell(page2, "A2")).edit).toBe("=A1*6");
  expect((await cell(page2, "A2")).text).toBe("42");
  await expect(page2.getByTestId("title")).toHaveValue("Answer");
});

test("closing the tab with an unsaved edit asks first", async ({ page }) => {
  await open(page);
  // Block the save so the edit stays unsaved.
  await page.evaluate(() => {
    indexedDB.open = (() => ({}) as IDBOpenDBRequest) as typeof indexedDB.open;
  });
  await typeAt(page, "A1", "not yet saved");
  await expect(page.getByTestId("status")).toHaveText(/Unsaved changes|Saving…/);
  const dialog = page.waitForEvent("dialog");
  void page.close({ runBeforeUnload: true });
  const d = await dialog;
  expect(d.type()).toBe("beforeunload");
  await d.dismiss();
  expect(page.isClosed()).toBe(false);
});
