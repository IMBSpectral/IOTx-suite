import { expect, type Page, test } from "@playwright/test";

type Sheets = {
  engine: { viewport: Function; info: Function };
  grid: {
    run(id: string, params: unknown): Promise<boolean>;
    cols: { offset(i: number): number; size(i: number): number };
    rows: { offset(i: number): number; size(i: number): number };
  };
};

const HEADER_W = 46;
const HEADER_H = 24;

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready");
}

async function run(page: Page, id: string, params: unknown): Promise<void> {
  const ok = await page.evaluate(([id, params]) => (window as unknown as { sheets: Sheets }).sheets.grid.run(id as string, params), [id, params]);
  expect(ok).toBe(true);
}

async function typeAt(page: Page, ref: string, value: string): Promise<void> {
  await page.getByTestId("namebox").fill(ref);
  await page.getByTestId("namebox").press("Enter");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

async function text(page: Page, row: number, col: number): Promise<string | undefined> {
  return page.evaluate(async ([row, col]) => {
    const vp = await (window as unknown as { sheets: Sheets }).sheets.engine.viewport(row, col, row, col);
    return vp.cells[0]?.[2];
  }, [row, col]);
}

/** Screen position (relative to the grid) of a point inside cell (row, col), unscrolled. */
async function cellPoint(page: Page, row: number, col: number, fx = 0.5, fy = 0.5): Promise<{ x: number; y: number }> {
  return page.evaluate(([row, col, fx, fy]) => {
    const { grid } = (window as unknown as { sheets: Sheets }).sheets;
    return {
      x: 46 + grid.cols.offset(col) + grid.cols.size(col) * fx,
      y: 24 + grid.rows.offset(row) + grid.rows.size(row) * fy,
    };
  }, [row, col, fx, fy]);
}

/** The canvas pixel at a grid-relative point, as `#rrggbb`. */
async function pixel(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([x, y]) => {
    const canvas = document.querySelector("canvas.grid-canvas") as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const d = canvas.getContext("2d")!.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }, [x, y]);
}

test("fills, borders and merged cells are painted", async ({ page }) => {
  await open(page);
  await run(page, "home.fillColor", { range: "B2", color: "#FFFF00" });
  await run(page, "home.borders", { range: "D4", preset: "all" });
  await typeAt(page, "B6", "merged");
  await run(page, "home.mergeCells", { range: "B6:D6" });
  const b2 = await cellPoint(page, 1, 1);
  await expect.poll(() => pixel(page, b2.x, b2.y)).toBe("#ffff00");
  // D4's top border is black where an ordinary gridline is light gray.
  const d4 = await cellPoint(page, 3, 3, 0.5, 0);
  await expect.poll(() => pixel(page, d4.x, d4.y + 0.5)).toBe("#000000");
  // Inside the merge, the gridline between B6 and C6 is gone.
  const seam = await cellPoint(page, 5, 2, 0, 0.8);
  await expect.poll(() => pixel(page, seam.x, seam.y)).toBe("#ffffff");
  const plain = await cellPoint(page, 7, 2, 0, 0.8);
  expect(await pixel(page, plain.x, plain.y)).not.toBe("#ffffff");
});

test("frozen rows stay on screen while the sheet scrolls", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "Header");
  await run(page, "view.freezePanes", { cell: "A2" });
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { sheets: Sheets }).sheets.engine.info())).freeze).toEqual([1, 0]);
  await page.getByTestId("grid").evaluate((el) => (el.scrollTop = 4000));
  // A click on the top data row lands on row 1 (frozen), and just below it on a far row.
  await page.getByTestId("grid").click({ position: { x: HEADER_W + 20, y: HEADER_H + 10 } });
  await expect(page.getByTestId("namebox")).toHaveValue("A1");
  await page.getByTestId("grid").click({ position: { x: HEADER_W + 20, y: HEADER_H + 30 } });
  const ref = await page.getByTestId("namebox").inputValue();
  expect(Number(ref.slice(1))).toBeGreaterThan(100);
});

test("dragging the fill handle continues a series", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "1");
  await typeAt(page, "A2", "2");
  await page.getByTestId("namebox").fill("A1:A2");
  await page.getByTestId("namebox").press("Enter");
  const handle = await cellPoint(page, 1, 0, 1, 1);
  const to = await cellPoint(page, 5, 0);
  const box = (await page.getByTestId("grid").boundingBox())!;
  await page.mouse.move(box.x + handle.x - 1, box.y + handle.y - 1);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => text(page, 5, 0)).toBe("6");
  await expect(page.getByTestId("namebox")).toHaveValue("A1:A6");
});

test("formulas that return several values show all of them", async ({ page }) => {
  await open(page);
  await typeAt(page, "C1", "=SEQUENCE(4)");
  await expect.poll(() => text(page, 3, 2)).toBe("4");
  expect(await text(page, 1, 2)).toBe("2");
});

test("wrapped, rotated and conditionally formatted cells paint without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await typeAt(page, "A1", "a long sentence that needs several lines to fit");
  await run(page, "home.wrapText", { range: "A1" });
  await run(page, "home.rowHeight", { rows: "1:1", height: 60 });
  await typeAt(page, "B1", "tilted");
  await run(page, "home.orientation", { range: "B1", angle: 45 });
  for (const [i, v] of ["10", "50", "90"].entries()) await typeAt(page, `C${i + 1}`, v);
  await run(page, "home.conditionalFormat", { range: "C1:C3", rule: { type: "dataBar" } });
  await run(page, "home.conditionalFormat", { range: "C1:C3", rule: { type: "colorScale" } });
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
  const vp = await page.evaluate(() => (window as unknown as { sheets: Sheets }).sheets.engine.viewport(0, 2, 2, 2));
  const styled = vp.cells.map((c: unknown[]) => vp.styles[String(c[4])]);
  expect(styled.some((s: { bar?: unknown; fill?: string }) => s?.bar || s?.fill)).toBe(true);
  await page.screenshot({ path: "test-results/render.png" });
});

test("a column's filter button filters by values and sorts", async ({ page }) => {
  await open(page);
  const rows = [["Fruit", "Qty"], ["apple", "3"], ["pear", "1"], ["apple", "5"], ["fig", "2"]];
  await run(page, "range.setValues", { range: "A1", values: rows });
  await run(page, "data.filter", { range: "A1:B5" });
  // The button sits on the right of the header cell A1.
  const btn = await cellPoint(page, 0, 0, 1, 0.5);
  await page.getByTestId("grid").click({ position: { x: btn.x - 10, y: btn.y } });
  const menu = page.getByTestId("filter-menu");
  await expect(menu).toBeVisible();
  await menu.getByText("Clear").click();
  await menu.getByLabel("apple").check();
  await menu.getByRole("button", { name: "OK" }).click();
  await expect(menu).toBeHidden();
  // pear (row 3) and fig (row 5) are hidden; the apples stay.
  const heights = async () =>
    page.evaluate(async () => (await (window as unknown as { sheets: Sheets }).sheets.engine.viewport(0, 0, 4, 0)).row_heights);
  await expect.poll(async () => (await heights()).map((h: number) => h > 0)).toEqual([true, true, false, true, false]);
  // Sort Qty Z → A from its own button, after showing everything again.
  await page.getByTestId("grid").click({ position: { x: btn.x - 10, y: btn.y } });
  await menu.getByText(/Select all/).click();
  await menu.getByRole("button", { name: "OK" }).click();
  await expect.poll(async () => (await heights()).every((h: number) => h > 0)).toBe(true);
  const qty = await cellPoint(page, 0, 1, 1, 0.5);
  await page.getByTestId("grid").click({ position: { x: qty.x - 10, y: qty.y } });
  await menu.getByText("Sort Z → A").click();
  await expect.poll(() => text(page, 1, 1)).toBe("5");
  expect(await text(page, 4, 1)).toBe("1");
  expect(await text(page, 0, 0)).toBe("Fruit");
});
