import { expect, type Page, test } from "@playwright/test";

// The grid is pixels on a canvas, so results are read straight from the worker's viewport.

function cellOf(ref: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [Number(m[2]) - 1, col];
}

interface Look {
  text?: string;
  style: Record<string, unknown> | null;
  merges: number[][];
}

async function look(page: Page, ref: string): Promise<Look> {
  return page.evaluate(async ([row, col]) => {
    const { engine } = (window as unknown as { sheets: { engine: { viewport: Function } } }).sheets;
    const vp = await engine.viewport(row, col, row, col);
    const c = vp.cells.find((x: unknown[]) => x[0] === row && x[1] === col);
    return { text: c?.[2], style: c ? (vp.styles[String(c[4])] ?? null) : null, merges: vp.merges };
  }, cellOf(ref));
}

const text = async (page: Page, ref: string) => (await look(page, ref)).text;
const style = async (page: Page, ref: string) => (await look(page, ref)).style ?? {};

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready");
}

async function go(page: Page, ref: string): Promise<void> {
  await page.getByTestId("namebox").fill(ref);
  await page.getByTestId("namebox").press("Enter");
  await expect(page.getByTestId("namebox")).toHaveValue(ref);
}

async function typeAt(page: Page, ref: string, value: string): Promise<void> {
  await go(page, ref);
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, ref)).not.toBeUndefined();
}

const tb = (page: Page) => page.getByRole("toolbar", { name: "Formatting" });
const btn = (page: Page, name: string) => tb(page).getByRole("button", { name, exact: true });
const item = (page: Page, name: string) => page.getByTestId("toolbar-popover").getByRole("menuitemcheckbox", { name, exact: true });
const choice = (page: Page, name: string) => page.getByTestId("toolbar-popover").getByRole("menuitem", { name, exact: true });
const swatch = (page: Page, name: string) => page.getByTestId("toolbar-popover").getByRole("menuitemradio", { name, exact: true });

test("currency, percent and decimal places change the displayed text", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "1234.5");
  await typeAt(page, "A2", "0.125");
  await typeAt(page, "A3", "2.5");
  await go(page, "A1");
  await btn(page, "Format as currency").click();
  await expect.poll(() => text(page, "A1")).toBe("$1,234.50");
  await btn(page, "Decrease decimal places").click();
  await expect.poll(() => text(page, "A1")).toBe("$1,234.5");
  await btn(page, "Increase decimal places").click();
  await btn(page, "Increase decimal places").click();
  await expect.poll(() => text(page, "A1")).toBe("$1,234.500");
  await go(page, "A2");
  await btn(page, "Format as percent").click();
  await expect.poll(() => text(page, "A2")).toBe("12.50%");
  // From General: start at the shown decimals.
  await go(page, "A3");
  await btn(page, "Increase decimal places").click();
  await expect.poll(() => text(page, "A3")).toBe("2.50");
  await btn(page, "Decrease decimal places").click();
  await btn(page, "Decrease decimal places").click();
  await expect.poll(() => text(page, "A3")).toBe("3");
  // The 123 menu: a named format and a custom code.
  await go(page, "A1");
  await btn(page, "More formats").click();
  await item(page, "Number").click();
  await expect.poll(() => text(page, "A1")).toBe("1,234.50");
  await btn(page, "More formats").click();
  await page.getByRole("textbox", { name: "Custom number format" }).fill("0.000");
  await page.getByRole("textbox", { name: "Custom number format" }).press("Enter");
  await expect.poll(() => text(page, "A1")).toBe("1234.500");
  await btn(page, "More formats").click();
  await item(page, "Automatic").click();
  await expect.poll(() => text(page, "A1")).toBe("1234.5");
});

test("font family and size are applied", async ({ page }) => {
  await open(page);
  await typeAt(page, "B1", "words");
  await go(page, "B1");
  await btn(page, "Font").click();
  await item(page, "Georgia").click();
  await expect.poll(async () => (await style(page, "B1")).font).toBe("Georgia");
  await expect(page.getByTestId("toolbar-font")).toHaveText("Georgia");
  const size = tb(page).getByRole("textbox", { name: "Font size" });
  await size.fill("14");
  await size.press("Enter");
  await expect.poll(async () => (await style(page, "B1")).size).toBe(14);
  await expect(size).toHaveValue("14");
  await btn(page, "Increase font size").click();
  await expect.poll(async () => (await style(page, "B1")).size).toBe(15);
  await btn(page, "Decrease font size").click();
  await btn(page, "Decrease font size").click();
  await expect.poll(async () => (await style(page, "B1")).size).toBe(13);
  // Picking from the size list.
  await size.click();
  await item(page, "24").click();
  await expect.poll(async () => (await style(page, "B1")).size).toBe(24);
  // Focus went back to the grid: typing edits the cell.
  await expect(page.getByTestId("cell-input")).toBeFocused();
});

test("text and fill colour, with reset", async ({ page }) => {
  await open(page);
  await typeAt(page, "C1", "colour");
  await go(page, "C1");
  await btn(page, "Text color").click();
  await swatch(page, "red").click();
  await expect.poll(async () => (await style(page, "C1")).color).toBe("#ff0000");
  await btn(page, "Fill color").click();
  await swatch(page, "light cornflower blue 3").click();
  await expect.poll(async () => (await style(page, "C1")).fill).toBe("#c9daf8");
  await btn(page, "Fill color").click();
  await choice(page, "Reset").click();
  await expect.poll(async () => (await style(page, "C1")).fill).toBeUndefined();
  await btn(page, "Text color").click();
  await choice(page, "Reset").click();
  await expect.poll(async () => (await style(page, "C1")).color ?? "#000000").toBe("#000000");
});

test("borders: all, then clear", async ({ page }) => {
  await open(page);
  for (const r of ["B2", "C2", "B3", "C3"]) await typeAt(page, r, r);
  await go(page, "B2:C3");
  await btn(page, "Borders").click();
  await choice(page, "All borders").click();
  for (const r of ["B2", "C2", "B3", "C3"]) {
    await expect.poll(async () => {
      const s = await style(page, r);
      return [!!s.bt, !!s.bb, !!s.bl, !!s.br];
    }).toEqual([true, true, true, true]);
  }
  await btn(page, "Borders").click();
  await choice(page, "Clear borders").click();
  await expect.poll(async () => {
    const s = await style(page, "C3");
    return [!!s.bt, !!s.bb, !!s.bl, !!s.br];
  }).toEqual([false, false, false, false]);
  // Outer only: an inside edge stays clear.
  await btn(page, "Borders").click();
  await choice(page, "Outer borders").click();
  await expect.poll(async () => {
    const s = await style(page, "B2");
    return [!!s.bt, !!s.bl, !!s.br, !!s.bb];
  }).toEqual([true, true, false, false]);
});

test("merge then unmerge", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "merged");
  await go(page, "A1:B2");
  await btn(page, "Merge cells").click();
  await expect.poll(async () => (await look(page, "A1")).merges).toEqual([[0, 0, 1, 1]]);
  await go(page, "A1");
  await expect(btn(page, "Merge cells")).toHaveAttribute("aria-pressed", "true");
  await btn(page, "Merge cells").click();
  await expect.poll(async () => (await look(page, "A1")).merges).toEqual([]);
  // Merge types from the menu.
  await go(page, "A1:B2");
  await btn(page, "Select merge type").click();
  await item(page, "Merge horizontally").click();
  await expect.poll(async () => (await look(page, "A1")).merges.length).toBe(1);
  await btn(page, "Select merge type").click();
  await item(page, "Unmerge").click();
  await expect.poll(async () => (await look(page, "A1")).merges).toEqual([]);
});

test("wrap toggle, alignment and rotation", async ({ page }) => {
  await open(page);
  await typeAt(page, "D1", "a long line of text");
  await go(page, "D1");
  await btn(page, "Text wrapping").click();
  await choice(page, "Wrap").click();
  await expect.poll(async () => (await style(page, "D1")).wrap).toBe(true);
  await btn(page, "Text wrapping").click();
  await choice(page, "Overflow").click();
  await expect.poll(async () => !!(await style(page, "D1")).wrap).toBe(false);
  await btn(page, "Horizontal align").click();
  await choice(page, "Center").click();
  await expect.poll(async () => (await style(page, "D1")).h).toBe("c");
  await btn(page, "Horizontal align").click();
  await expect(choice(page, "Center")).toHaveAttribute("aria-pressed", "true");
  await choice(page, "Right").click();
  await expect.poll(async () => (await style(page, "D1")).h).toBe("r");
  await btn(page, "Vertical align").click();
  await choice(page, "Top").click();
  await expect.poll(async () => (await style(page, "D1")).v).toBe("t");
  await btn(page, "Vertical align").click();
  await choice(page, "Middle").click();
  await expect.poll(async () => (await style(page, "D1")).v).toBe("m");
  await btn(page, "Text rotation").click();
  await choice(page, "Tilt up").click();
  await expect.poll(async () => (await style(page, "D1")).rot).toBe(45);
  await btn(page, "Text rotation").click();
  await choice(page, "Rotate down").click();
  await expect.poll(async () => (await style(page, "D1")).rot).toBe(-90);
});

test("clear formatting and undo/redo", async ({ page }) => {
  await open(page);
  await typeAt(page, "E1", "fmt");
  await go(page, "E1");
  await btn(page, "Bold").click();
  await btn(page, "Italic").click();
  await btn(page, "Strikethrough").click();
  await expect.poll(async () => {
    const s = await style(page, "E1");
    return [!!s.b, !!s.i, !!s.s];
  }).toEqual([true, true, true]);
  await btn(page, "Fill color").click();
  await swatch(page, "yellow").click();
  await expect.poll(async () => (await style(page, "E1")).fill).toBe("#ffff00");
  await btn(page, "Clear formatting").click();
  await expect.poll(async () => {
    const s = await style(page, "E1");
    return [!!s.b, !!s.i, !!s.s, s.fill ?? null];
  }).toEqual([false, false, false, null]);
  // Undo brings the formats back; redo clears them again.
  await btn(page, "Undo").click();
  await expect.poll(async () => (await style(page, "E1")).fill).toBe("#ffff00");
  await expect.poll(async () => !!(await style(page, "E1")).b).toBe(true);
  await btn(page, "Redo").click();
  await expect.poll(async () => (await style(page, "E1")).fill).toBeUndefined();
  await btn(page, "Undo").click();
  await btn(page, "Undo").click();
  await expect.poll(async () => (await style(page, "E1")).fill).toBeUndefined();
  await expect.poll(async () => !!(await style(page, "E1")).s).toBe(true);
});

test("the toolbar reflects the active cell", async ({ page }) => {
  await open(page);
  await typeAt(page, "B1", "bold");
  await typeAt(page, "C1", "plain");
  await go(page, "B1");
  await btn(page, "Bold").click();
  await expect.poll(async () => !!(await style(page, "B1")).b).toBe(true);
  await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("ArrowLeft");
  await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "true");
  // Bold again on a bold cell turns it off (the button is a toggle of the cell's state).
  await btn(page, "Bold").click();
  await expect.poll(async () => !!(await style(page, "B1")).b).toBe(false);
  await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "false");

  // Font and size follow the cell.
  await btn(page, "Font").click();
  await item(page, "Courier New").click();
  await expect(page.getByTestId("toolbar-font")).toHaveText("Courier New");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("toolbar-font")).toHaveText("Default (Calibri)");
  await expect(tb(page).getByRole("textbox", { name: "Font size" })).toHaveValue("11");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("toolbar-font")).toHaveText("Courier New");
  // The undo button is enabled once there is something to undo.
  await expect(btn(page, "Undo")).toBeEnabled();
});

test("paint format copies the picked-up format to the next clicked cell", async ({ page }) => {
  await open(page);
  await typeAt(page, "A1", "source");
  await typeAt(page, "C4", "target");
  await go(page, "A1");
  await btn(page, "Bold").click();
  await btn(page, "Text color").click();
  await swatch(page, "blue").click();
  await expect.poll(async () => (await style(page, "A1")).color).toBe("#0000ff");
  await btn(page, "Paint format").click();
  await expect(btn(page, "Paint format")).toHaveAttribute("aria-pressed", "true");
  // Column C (46 + 2*64 + 10), row 4 (24 + 3*20 + 10), as in grid.spec.
  await page.getByTestId("grid").click({ position: { x: 46 + 128 + 10, y: 24 + 60 + 10 } });
  await expect(page.getByTestId("namebox")).toHaveValue("C4");
  await expect.poll(async () => (await style(page, "C4")).color).toBe("#0000ff");
  expect(!!(await style(page, "C4")).b).toBe(true);
  await expect(btn(page, "Paint format")).toHaveAttribute("aria-pressed", "false");
  // Escape cancels an armed painter.
  await btn(page, "Paint format").click();
  await expect(btn(page, "Paint format")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(btn(page, "Paint format")).toHaveAttribute("aria-pressed", "false");
});

test("insert link sets the cell's text", async ({ page }) => {
  await open(page);
  await go(page, "F2");
  await btn(page, "Insert link").click();
  await page.getByRole("textbox", { name: "Link text" }).fill("Example");
  await page.getByRole("textbox", { name: "Link URL" }).fill("https://example.com");
  await page.getByRole("textbox", { name: "Link URL" }).press("Enter");
  await expect.poll(() => text(page, "F2")).toBe("Example");
  await expect(page.getByTestId("cell-input")).toBeFocused();
});

test("popovers close on Escape and outside clicks; the bar fits on one line", async ({ page }) => {
  await open(page);
  await btn(page, "Borders").click();
  await expect(page.getByTestId("toolbar-popover")).toBeVisible();
  await expect(btn(page, "Borders")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("toolbar-popover")).toHaveCount(0);
  await expect(page.getByTestId("cell-input")).toBeFocused();
  await btn(page, "Text color").click();
  await expect(page.getByTestId("toolbar-popover")).toBeVisible();
  await page.getByTestId("grid").click({ position: { x: 300, y: 300 } });
  await expect(page.getByTestId("toolbar-popover")).toHaveCount(0);
  // Clicking a toolbar button leaves the focus in the grid.
  await btn(page, "Italic").click();
  await expect(page.getByTestId("cell-input")).toBeFocused();
  // 1280px wide: one row, nothing scrolled out of view.
  const fits = await tb(page).evaluate((n) => ({ sw: n.scrollWidth, cw: n.clientWidth, h: n.clientHeight }));
  expect(fits.sw).toBeLessThanOrEqual(fits.cw);
  expect(fits.h).toBeLessThanOrEqual(44);
  if (process.env.TOOLBAR_SHOTS) {
    const dir = process.env.TOOLBAR_SHOTS;
    await page.screenshot({ path: `${dir}/page.png`, clip: { x: 0, y: 0, width: 1280, height: 140 } });
    for (const name of ["Text color", "Borders", "More formats", "Text rotation", "Font"]) {
      await btn(page, name).click();
      await page.screenshot({ path: `${dir}/${name.replace(/ /g, "-")}.png`, clip: { x: 0, y: 0, width: 1280, height: 560 } });
      await page.keyboard.press("Escape");
    }
  }
});
