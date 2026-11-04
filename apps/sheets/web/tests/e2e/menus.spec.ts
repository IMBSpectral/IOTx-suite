import { expect, type Page, test } from "@playwright/test";

// Geometry of the grid (see grid.spec.ts): 46px row header, 24px column header, 64px columns
// and 20px rows by default.
const HW = 46;
const HH = 24;
const CW = 64;
const RH = 20;
const cellPos = (row: number, col: number) => ({ x: HW + col * CW + CW / 2, y: HH + row * RH + RH / 2 });
const colHeader = (col: number) => ({ x: HW + col * CW + CW / 2, y: HH / 2 });
const rowHeader = (row: number) => ({ x: HW / 2, y: HH + row * RH + RH / 2 });

type Sheets = { sheets: { engine: { viewport: Function; info: Function }; grid: { selectLines: Function } } };

/** Reads display text straight from the worker (the grid itself is pixels on a canvas). */
async function text(page: Page, ref: string): Promise<string | undefined> {
  return page.evaluate(async (ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(m[2]) - 1;
    const { engine } = (window as unknown as Sheets).sheets;
    const vp = await engine.viewport(row, col, row, col);
    return vp.cells[0]?.[2];
  }, ref);
}

async function info(page: Page): Promise<{ sheets: { name: string; hidden: boolean; color?: string }[]; active: number; freeze: [number, number] }> {
  return page.evaluate(() => (window as unknown as Sheets).sheets.engine.info());
}

async function colWidth(page: Page, col: number): Promise<number> {
  return page.evaluate(async (c) => (await (window as unknown as Sheets).sheets.engine.viewport(0, c, 0, c)).col_widths[0], col);
}

async function filter(page: Page): Promise<unknown> {
  return page.evaluate(async () => (await (window as unknown as Sheets).sheets.engine.viewport(0, 0, 0, 0)).filter ?? null);
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

async function rightClick(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.getByTestId("grid").click({ button: "right", position: at });
}

/** Opens a menu bar menu and walks submenus by their visible labels; the last one is clicked. */
async function menu(page: Page, top: string, ...path: string[]): Promise<void> {
  await page.getByTestId(`menubar-${top.toLowerCase()}`).click();
  for (const label of path) {
    await page.locator(".menu-popup").last().getByRole("menuitem", { name: label, exact: true }).click();
  }
}

test("cell menu: Insert 1 row above shifts data down", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "one");
  await typeAt(page, "A2", "two");
  await rightClick(page, cellPos(1, 0));
  const m = page.getByTestId("cell-menu");
  await expect(m).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Insert 1 column left" })).toBeVisible();
  await m.getByRole("menuitem", { name: "Insert 1 row above" }).click();
  await expect(m).toBeHidden();
  await expect.poll(() => text(page, "A3")).toBe("two");
  expect(await text(page, "A2")).toBeUndefined();
  expect(await text(page, "A1")).toBe("one");
});

test("cell menu labels count the selection and Escape closes it", async ({ page }) => {
  await open(page);
  await goTo(page, "B2:C4");
  await rightClick(page, cellPos(2, 1));
  const m = page.getByTestId("cell-menu");
  await expect(m.getByRole("menuitem", { name: "Insert 3 rows above" })).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Insert 2 columns right" })).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Delete rows 2 - 4" })).toBeVisible();
  await expect(m.getByRole("menuitem", { name: "Delete columns B - C" })).toBeVisible();
  // Keyboard: arrows move, Escape closes and the grid keeps the keys.
  await page.keyboard.press("ArrowDown");
  await expect(m.getByRole("menuitem", { name: "Cut" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(m).toBeHidden();
  await expect(page.getByTestId("cell-input")).toBeFocused();
});

test("column header menu: Delete column", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "a");
  await typeAt(page, "B1", "b");
  await typeAt(page, "C1", "c");
  await rightClick(page, colHeader(1));
  const m = page.getByTestId("col-menu");
  await expect(m.getByRole("menuitem", { name: "Resize column" })).toBeVisible();
  await m.getByRole("menuitem", { name: "Delete column" }).click();
  await expect.poll(() => text(page, "B1")).toBe("c");
  expect(await text(page, "A1")).toBe("a");
});

test("column header menu: hide and unhide a column", async ({ page }) => {
  await open(page);
  await typeAt(page, "C1", "hide me");
  await rightClick(page, colHeader(2));
  await page.getByTestId("col-menu").getByRole("menuitem", { name: "Hide column" }).click();
  await expect.poll(() => colWidth(page, 2)).toBe(0);
  // Select B:D (C is hidden in between) and unhide from the header menu.
  await page.evaluate(() => (window as unknown as Sheets).sheets.grid.selectLines("col", 1, 3));
  await rightClick(page, colHeader(1));
  await page.getByTestId("col-menu").getByRole("menuitem", { name: "Unhide column" }).click();
  await expect.poll(() => colWidth(page, 2)).toBeGreaterThan(0);
});

test("row header menu: resize row and insert below", async ({ page }) => {
  await open(page);
  await typeAt(page, "A2", "x");
  await rightClick(page, rowHeader(1));
  const m = page.getByTestId("row-menu");
  await m.getByRole("menuitem", { name: "Resize row" }).click();
  const dlg = page.getByTestId("resize-dialog");
  await expect(dlg).toBeVisible();
  await page.getByTestId("resize-size").fill("40");
  await page.getByTestId("resize-ok").click();
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as Sheets).sheets.engine.viewport(1, 0, 1, 0)).row_heights[0])).toBe(40);
  await rightClick(page, rowHeader(1));
  await page.getByTestId("row-menu").getByRole("menuitem", { name: "Insert 1 row above" }).click();
  await expect.poll(() => text(page, "A3")).toBe("x");
});

test("View › Freeze › 1 row", async ({ page }) => {
  await open(page);
  await page.getByTestId("menubar-view").click();
  await page.getByRole("menuitem", { name: "Freeze" }).click();
  await page.getByTestId("menu-freeze-rows-1").click();
  await expect.poll(async () => (await info(page)).freeze).toEqual([1, 0]);
  // The check mark follows the state.
  await page.getByTestId("menubar-view").click();
  await page.getByRole("menuitem", { name: "Freeze" }).click();
  await expect(page.getByTestId("menu-freeze-rows-1")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("menu-freeze-rows-0").click();
  await expect.poll(async () => (await info(page)).freeze).toEqual([0, 0]);
});

test("Data › Sort range A to Z", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "pear");
  await typeAt(page, "A2", "apple");
  await typeAt(page, "A3", "fig");
  await goTo(page, "A1:A3");
  await page.getByTestId("menubar-data").click();
  await page.getByRole("menuitem", { name: "Sort range" }).click();
  await page.getByTestId("menu-sort-range-asc").click();
  await expect.poll(() => text(page, "A1")).toBe("apple");
  expect(await text(page, "A2")).toBe("fig");
  expect(await text(page, "A3")).toBe("pear");
});

test("Data › Create a filter, then Remove filter", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "Name");
  await typeAt(page, "A2", "x");
  await typeAt(page, "A3", "y");
  await goTo(page, "A1");
  await page.getByTestId("menubar-data").click();
  await page.getByTestId("menu-data-filter").click();
  await expect.poll(() => filter(page)).not.toBeNull();
  await page.getByTestId("menubar-data").click();
  await expect(page.getByTestId("menu-data-filter")).toHaveAttribute("aria-label", "Remove filter");
  await page.getByTestId("menu-data-filter").click();
  await expect.poll(() => filter(page)).toBeNull();
});

test("double-click a tab renames the sheet", async ({ page }) => {
  await open(page);
  await page.getByTestId("tab-0").dblclick();
  const input = page.getByTestId("tab-rename");
  await expect(input).toBeFocused();
  await input.fill("Budget");
  await input.press("Enter");
  await expect.poll(async () => (await info(page)).sheets[0].name).toBe("Budget");
  await expect(page.getByTestId("tab-0")).toHaveText(/Budget/);
});

test("tab menu: Duplicate, Change color, Delete", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "original");
  // Duplicate makes "Copy of Sheet1" after it and switches to it.
  await page.getByTestId("tab-0").click({ button: "right" });
  await page.getByTestId("tab-menu").getByRole("menuitem", { name: "Duplicate" }).click();
  await expect.poll(async () => (await info(page)).sheets.map((s) => s.name)).toEqual(["Sheet1", "Copy of Sheet1"]);
  expect((await info(page)).active).toBe(1);
  await expect.poll(() => text(page, "A1")).toBe("original");
  // Tab colour via the ▾ on the active tab.
  await page.getByTestId("tab-arrow").click();
  await page.getByTestId("tab-menu").getByRole("menuitem", { name: "Change color" }).click();
  await page.getByTestId("swatch-ff0000").click();
  await expect.poll(async () => (await info(page)).sheets[1].color?.toLowerCase()).toBe("#ff0000");
  await expect(page.getByTestId("tab-1")).toHaveClass(/colored/);
  // Delete it.
  await page.getByTestId("tab-1").click({ button: "right" });
  await page.getByTestId("tab-menu").getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(async () => (await info(page)).sheets.length).toBe(1);
  // The last sheet can't be deleted or hidden.
  await page.getByTestId("tab-0").click({ button: "right" });
  await expect(page.getByTestId("tab-menu").getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("tab-menu").getByRole("menuitem", { name: "Hide sheet" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});

test("hidden sheets come back from the All sheets list", async ({ page }) => {
  await open(page);
  await page.getByTestId("add-sheet").click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByTestId("tab-1").click({ button: "right" });
  await page.getByTestId("tab-menu").getByRole("menuitem", { name: "Hide sheet" }).click();
  await expect.poll(async () => (await info(page)).sheets[1].hidden).toBe(true);
  await page.getByTestId("all-sheets").click();
  await page.getByTestId("menu-all-sheets-1").click();
  await expect.poll(async () => (await info(page)).sheets[1].hidden).toBe(false);
  expect((await info(page)).active).toBe(1);
});

test("Ctrl+F finds and steps through matches", async ({ page }) => {
  await open(page);
  await typeAt(page, "B2", "apple pie");
  await typeAt(page, "D7", "Apple");
  await typeAt(page, "A10", "pear");
  await goTo(page, "A1");
  await page.keyboard.press("Control+f");
  const input = page.getByTestId("find-input");
  await expect(input).toBeFocused();
  await input.fill("apple");
  await expect(page.getByTestId("find-count")).toHaveText("1 of 2");
  await expect(page.getByTestId("namebox")).toHaveValue("B2");
  await expect(page.locator(".find-hit")).toHaveCount(2);
  await input.press("Enter");
  await expect(page.getByTestId("namebox")).toHaveValue("D7");
  await expect(page.getByTestId("find-count")).toHaveText("2 of 2");
  await input.press("Shift+Enter");
  await expect(page.getByTestId("namebox")).toHaveValue("B2");
  await input.press("Escape");
  await expect(page.getByTestId("find-box")).toBeHidden();
  await expect(page.getByTestId("cell-input")).toBeFocused();
});

test("Ctrl+H Replace all replaces and reports the count", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "cat");
  await typeAt(page, "A2", "black cat");
  await typeAt(page, "B3", "dog");
  await page.keyboard.press("Control+h");
  const dlg = page.getByTestId("replace-dialog");
  await expect(dlg).toBeVisible();
  await page.getByTestId("replace-find").fill("cat");
  await page.getByTestId("replace-with").fill("fox");
  await page.getByTestId("replace-all-btn").click();
  await expect(page.getByTestId("replace-status")).toHaveText("Replaced 2 instances of cat with fox");
  expect(await text(page, "A1")).toBe("fox");
  expect(await text(page, "A2")).toBe("black fox");
  expect(await text(page, "B3")).toBe("dog");
  await page.getByTestId("replace-done").click();
  await expect(dlg).toBeHidden();
});

test("Edit menu: Find and replace › Find moves to the match", async ({ page }) => {
  await open(page);
  await typeAt(page, "C5", "needle");
  await goTo(page, "A1");
  await page.getByTestId("menubar-edit").click();
  await page.getByTestId("menu-edit-replace").click();
  await page.getByTestId("replace-find").fill("needle");
  await page.getByTestId("replace-find-btn").click();
  await expect(page.getByTestId("namebox")).toHaveValue("C5");
});

test("Help › Keyboard shortcuts opens the list", async ({ page }) => {
  await open(page);
  await page.getByTestId("menubar-help").click();
  await page.getByTestId("menu-help-shortcuts").click();
  const dlg = page.getByTestId("shortcuts-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(dlg).toContainText("Find and replace");
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await page.keyboard.press("Control+/");
  await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
});

test("menu bar is keyboard navigable", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Alt+e");
  const edit = page.getByTestId("menu-edit");
  await expect(edit).toBeVisible();
  await expect(page.getByTestId("menubar-edit")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("menu-view")).toBeVisible();
  await expect(edit).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("menu-view")).toBeHidden();
  // Hovering the bar while a menu is open switches menus.
  await page.getByTestId("menubar-insert").click();
  await page.getByTestId("menubar-format").hover();
  await expect(page.getByTestId("menu-format")).toBeVisible();
  await page.mouse.click(600, 500);
  await expect(page.getByTestId("menu-format")).toBeHidden();
});

test("Insert › Rows › Insert 1 row below and Format › Text › Bold", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "top");
  await typeAt(page, "A2", "next");
  await goTo(page, "A1");
  await menu(page, "Insert", "Rows", "Insert 1 row below");
  await expect.poll(() => text(page, "A3")).toBe("next");
  await menu(page, "Format", "Text", "Bold");
  const bold = await page.evaluate(async () => {
    const vp = await (window as unknown as Sheets).sheets.engine.viewport(0, 0, 0, 0);
    return vp.styles[String(vp.cells[0][4])]?.b === true;
  });
  expect(bold).toBe(true);
});
