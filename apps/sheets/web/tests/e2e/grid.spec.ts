import { expect, type Page, test } from "@playwright/test";

/** Reads display text straight from the worker (the grid itself is pixels on a canvas). */
async function text(page: Page, ref: string): Promise<string | undefined> {
  return page.evaluate(async (ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(m[2]) - 1;
    const { engine } = (window as unknown as { sheets: { engine: { viewport: Function } } }).sheets;
    const vp = await engine.viewport(row, col, row, col);
    return vp.cells[0]?.[2];
  }, ref);
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready");
}

async function typeAt(page: Page, ref: string, value: string): Promise<void> {
  await page.getByTestId("namebox").fill(ref);
  await page.getByTestId("namebox").press("Enter");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

test("typing values and a formula recalculates in the worker", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "12");
  await typeAt(page, "A2", "30");
  await typeAt(page, "A3", "=SUM(A1:A2)");
  await expect.poll(() => text(page, "A3")).toBe("42");
  // The active cell moved down; the formula bar shows A3's formula when selected.
  await page.getByTestId("namebox").fill("A3");
  await page.getByTestId("namebox").press("Enter");
  await expect(page.getByTestId("formula")).toHaveValue("=SUM(A1:A2)");
  // Change an input; the dependent updates.
  await typeAt(page, "A1", "100");
  await expect.poll(() => text(page, "A3")).toBe("130");
});

test("clicking a cell selects it and arrow keys move", async ({ page }) => {
  await open(page);
  const grid = page.getByTestId("grid");
  // Column C (46 + 2*64 + 10), row 4 (24 + 3*20 + 10).
  await grid.click({ position: { x: 46 + 128 + 10, y: 24 + 60 + 10 } });
  await expect(page.getByTestId("namebox")).toHaveValue("C4");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("namebox")).toHaveValue("D5");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByTestId("namebox")).toHaveValue("D5:E6");
});

test("undo, redo and bold go through the engine", async ({ page }) => {
  await open(page);
  await typeAt(page, "B2", "first");
  await typeAt(page, "B2", "second");
  await page.keyboard.press("Control+z");
  await expect.poll(() => text(page, "B2")).toBe("first");
  await page.keyboard.press("Control+y");
  await expect.poll(() => text(page, "B2")).toBe("second");
  await page.getByTestId("namebox").fill("B2");
  await page.getByTestId("namebox").press("Enter");
  await page.getByRole("button", { name: "Bold" }).click();
  const bold = await page.evaluate(async () => {
    const { engine } = (window as unknown as { sheets: { engine: { viewport: Function } } }).sheets;
    const vp = await engine.viewport(1, 1, 1, 1);
    return vp.styles[String(vp.cells[0][4])]?.b === true;
  });
  expect(bold).toBe(true);
});

test("escape cancels an edit and errors show as #VALUE-style results, not crashes", async ({ page }) => {
  await open(page);
  await typeAt(page, "C1", "keep");
  await page.getByTestId("namebox").fill("C1");
  await page.getByTestId("namebox").press("Enter");
  await page.keyboard.type("discard");
  await page.keyboard.press("Escape");
  await expect.poll(() => text(page, "C1")).toBe("keep");
  await typeAt(page, "D1", "=1/0");
  await expect.poll(() => text(page, "D1")).toBe("#DIV/0!");
});

test("sheets can be added and switched", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "on sheet one");
  await page.getByTestId("add-sheet").click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => text(page, "A1")).toBeUndefined();
  await page.getByRole("tab").nth(0).click();
  await expect.poll(() => text(page, "A1")).toBe("on sheet one");
});

test("the grid paints pixels (canvas, not DOM cells)", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "visible");
  expect(await page.locator("canvas.grid-canvas").count()).toBe(1);
  expect(await page.locator("td").count()).toBe(0);
  await page.screenshot({ path: "test-results/app.png" });
});

test("fast typing with Enter puts every value in its own cell", async ({ page }) => {
  await open(page);
  await page.keyboard.type("1\n2\n3\n=SUM(A1:A3)\n", { delay: 0 });
  await expect.poll(() => text(page, "A4")).toBe("6");
  expect(await text(page, "A1")).toBe("1");
  expect(await text(page, "A3")).toBe("3");
  await expect(page.getByTestId("namebox")).toHaveValue("A5");
  for (const k of ["x", "Tab", "y", "Tab", "z", "Enter"]) {
    if (k.length > 1) await page.keyboard.press(k);
    else await page.keyboard.type(k, { delay: 0 });
  }
  await expect.poll(() => text(page, "C5")).toBe("z");
  expect(await text(page, "B5")).toBe("y");
});
